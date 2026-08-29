import { z } from "zod/v4";
import { canonicalizeArgs, computeDedupeKey } from "../canonical-args";
import { resolveSheet } from "../resolve-sheet";
import {
  SheetsAmbiguousWriteError,
  SheetsApiError,
  type SheetsWriteResult,
  type ValueInputOption,
} from "../sheets-client";
import type { SheetsToolContext, SheetsToolDeps } from "./tool-deps";

const TOOL_NAME = "sheets_write";

const cellValue = z.union([z.string(), z.number(), z.boolean()]);
const valuesSchema = z.array(z.array(cellValue));
const valueInputOptionSchema = z.enum(["RAW", "USER_ENTERED"]).optional();

const schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("append"),
    sheet: z.string(),
    range: z.string(),
    values: valuesSchema,
    valueInputOption: valueInputOptionSchema,
  }),
  z.object({
    mode: z.literal("update"),
    sheet: z.string(),
    range: z.string(),
    values: valuesSchema,
    valueInputOption: valueInputOptionSchema,
  }),
]);

/** The claim/complete port over `sheet_write_log` (`@hermes/store`'s `sheet-write-log-repo.ts`) — declared here, the consumer, per this codebase's consumer-declares-its-port convention (`SheetRegistryPort`/`AccessTokenPort` follow the same shape). `apps/hermes/src/boot.ts` binds this directly to `@hermes/store`'s `claimSheetWrite`/`completeSheetWrite`, the same inline-object wiring `apps/hermes/src/handlers/complete.ts`'s `dedupeRepo` already uses for `llm_dedupe`. */
export interface SheetWriteLogPort {
  claim(
    dedupeKey: string,
    input: {
      channel: string;
      channelUserId: string;
      turnId: string;
      tool: string;
      canonicalArgs: unknown;
    },
  ): Promise<"claimed" | { alreadyComplete: true; outcome: unknown } | { alreadyPending: true }>;
  complete(dedupeKey: string, outcome: unknown): Promise<void>;
  /**
   * Releases a still-`pending` claim after a *provably-definitive* write
   * failure — the request reached Google and was rejected outright, or
   * never got past quota enforcement — so a legitimate same-turn retry
   * isn't permanently blocked by `alreadyPending`'s fail-closed hedge over a
   * write that definitely never landed. Optional: a caller that never
   * constructs this branch (e.g. a fake in a test not exercising it) need
   * not implement it. Never called for a genuinely ambiguous failure — the
   * fail-safe default stays "when in doubt, hedge" (see `performWrite`'s
   * `SheetsApiError` branch below).
   */
  release?(dedupeKey: string): Promise<void>;
}

export interface CreateSheetsWriteToolDeps extends SheetsToolDeps {
  sheetWriteLogRepo: SheetWriteLogPort;
}

/** `{ ok: false, reason: "read_only_sheet" }` — the write-specific refusal `sheets_inspect`/`sheets_read` never need, since any registered `access` permits a read. */
export interface ReadOnlySheetResult {
  ok: false;
  reason: "read_only_sheet";
}

/** `mode: "append"`'s non-retried post-send-ambiguous outcome — a distinct, structured "check the sheet" result, not a bare thrown error, so the model can relay it as-is (settled decision 15). */
export interface AmbiguousWriteResult {
  ok: false;
  reason: "ambiguous_write";
  message: string;
}

/**
 * A claim finding an EXISTING `pending` `sheet_write_log` row for this exact
 * key: someone already started this exact write and we don't know how it
 * ended (still genuinely in flight, or crashed after the write landed but
 * before `complete()` recorded it). Never proceed to write again — surface
 * the same ambiguous hedge a post-send-ambiguous client failure gets,
 * without a second API call. Deliberately *not* recorded via `complete()`:
 * this call did not originate the write, so it isn't authoritative over the
 * row's eventual true outcome — stamping it here risks clobbering a later,
 * genuine `complete()` call from whichever attempt actually owns this claim.
 */
const PENDING_CLAIM_MESSAGE =
  "Sheets write may or may not have landed: a previous attempt for this exact write already started and never recorded completion — check the sheet before retrying.";

export interface SheetsWriteSuccessResult {
  ok: true;
  sheet: string;
  mode: "append" | "update";
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

/**
 * Shared by both modes' branches below: calls `callApi` (the mode-specific
 * `appendValues`/`updateValues` invocation), then resolves the dedupe claim
 * one of three ways — a caught `SheetsAmbiguousWriteError` records and
 * returns the structured hedge; a caught `SheetsApiError` releases the still
 * -pending claim before rethrowing (see the definitive-vs-ambiguous split in
 * the handler's own doc comment above); any other thrown error propagates
 * with the claim left pending. On success, records and returns the
 * `SheetsWriteSuccessResult` — the success-outcome-plus-`complete()` shape
 * both `append` and `update` previously duplicated inline.
 */
async function performWrite(
  deps: CreateSheetsWriteToolDeps,
  dedupeKey: string,
  mode: "append" | "update",
  sheetSlug: string,
  callApi: () => Promise<SheetsWriteResult>,
): Promise<SheetsWriteSuccessResult | AmbiguousWriteResult> {
  let writeResult: SheetsWriteResult;
  try {
    writeResult = await callApi();
  } catch (error) {
    if (error instanceof SheetsAmbiguousWriteError) {
      const outcome: AmbiguousWriteResult = {
        ok: false,
        reason: "ambiguous_write",
        message: error.message,
      };
      await deps.sheetWriteLogRepo.complete(dedupeKey, outcome);
      return outcome;
    }
    if (error instanceof SheetsApiError) {
      // Definitive, not ambiguous: `sheets-client.ts`'s `classifyWrite` only
      // ever lets a `SheetsApiError` escape `appendValues`/`updateValues` for
      // a non-429 4xx (thrown immediately — Google rejected the request
      // outright) or an exhausted 429 (thrown after retries — Google never
      // got past quota enforcement to apply it). Either way the request
      // never mutated the sheet, so the pending claim is released rather
      // than left to permanently hedge a legitimate same-turn retry. Any
      // other error here (a network failure that can't be proven pre-send, a
      // malformed body after a 2xx, ...) falls through unreleased —
      // fail-safe stays "when in doubt, hedge" (settled decision 15).
      await deps.sheetWriteLogRepo.release?.(dedupeKey);
    }
    throw error;
  }
  const outcome: SheetsWriteSuccessResult = {
    ok: true,
    sheet: sheetSlug,
    mode,
    ...writeResult,
  };
  await deps.sheetWriteLogRepo.complete(dedupeKey, outcome);
  return outcome;
}

/**
 * Computes the dedupe key and resolves `sheetWriteLogRepo.claim` against it
 * — the one dedupe/claim sequence both `mode`s share before ever touching
 * the Sheets API. Returns `{ shortCircuit }` with the already-resolved
 * outcome to return as-is when the claim short-circuits (an existing
 * `complete`d row, or one still `pending` from another in-flight attempt);
 * otherwise `{ dedupeKey }`, the fresh key this call now owns writing to.
 */
async function claimDedupeKey(
  deps: CreateSheetsWriteToolDeps,
  parsed: z.infer<typeof schema>,
  ctx: SheetsToolContext,
): Promise<{ shortCircuit: unknown } | { dedupeKey: string }> {
  const canonicalArgsJson = canonicalizeArgs(parsed);
  const dedupeKey = computeDedupeKey({
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgsJson,
  });

  const claimResult = await deps.sheetWriteLogRepo.claim(dedupeKey, {
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgs: JSON.parse(canonicalArgsJson) as unknown,
  });
  if (typeof claimResult === "object" && "alreadyComplete" in claimResult) {
    return { shortCircuit: claimResult.outcome };
  }
  if (typeof claimResult === "object" && "alreadyPending" in claimResult) {
    return {
      shortCircuit: {
        ok: false,
        reason: "ambiguous_write",
        message: PENDING_CLAIM_MESSAGE,
      } satisfies AmbiguousWriteResult,
    };
  }
  return { dedupeKey };
}

/**
 * `sheets_write`: appends or overwrites rows in a registered spreadsheet.
 * `requiresApproval: true` routes every call through the approval gate
 * before this handler ever runs. Order inside the handler is load-bearing
 * (see the Steps in `plans/05-google-sheets.md` Phase 5): resolve the slug,
 * enforce `access === "readwrite"`, *then* claim the dedupe key, *then* call
 * the Sheets API — a `read`-access refusal never reaches the claim or the
 * API, and a same-turn retry (identical `(channel, channelUserId, turnId,
 * tool, canonical args)`) short-circuits on the claim before ever calling
 * the client a second time.
 *
 * Both modes share `performWrite`'s definitive-vs-ambiguous release logic: a
 * `SheetsApiError` — the request reached Google and was rejected outright,
 * or an exhausted 429 that never got applied — releases the still-pending
 * claim (via `sheetWriteLogRepo.release`) before rethrowing, so a legitimate
 * same-turn retry isn't blocked hedging over a write that provably never
 * landed; any other error keeps the pending row (fail-safe default). Only
 * `mode: "append"` can additionally throw `SheetsAmbiguousWriteError`
 * (`sheets-client.ts`'s `appendValues` never retries a post-send-ambiguous
 * failure) — `performWrite` catches that specific type and turns it into a
 * structured `AmbiguousWriteResult`, recorded via `complete` the same as any
 * other outcome so a same-turn duplicate claim returns the same hedge
 * without a second API call. `mode: "update"`'s client-internal single retry
 * means `updateValues` never throws that type at all — any post-send
 * ambiguity it can't resolve internally surfaces as a plain fatal error
 * (`packages/agent`'s `invokeTool` turns a thrown handler error into the
 * tool-result message itself, settled decision 15), leaving its claim
 * pending rather than released.
 */
export function createSheetsWriteTool(deps: CreateSheetsWriteToolDeps) {
  return {
    name: TOOL_NAME,
    description:
      "Writes rows to a registered spreadsheet by slug. Args: { mode: 'append' | 'update', sheet, range, values, valueInputOption? }. 'append' adds new rows after the given range; 'update' overwrites the exact range given. values is a 2D array (rows of cells). Only permitted against a sheet registered with readwrite access. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    handler: async (args: unknown, ctx: SheetsToolContext): Promise<unknown> => {
      const parsed = args as z.infer<typeof schema>;
      const { mode, sheet, range, values, valueInputOption: overrideOption } = parsed;

      const resolved = await resolveSheet(deps.sheetRegistry, sheet);
      if (!resolved.ok) return resolved;

      if (resolved.entry.access !== "readwrite") {
        return { ok: false, reason: "read_only_sheet" } satisfies ReadOnlySheetResult;
      }

      const claim = await claimDedupeKey(deps, parsed, ctx);
      if ("shortCircuit" in claim) return claim.shortCircuit;
      const { dedupeKey } = claim;

      const valueInputOption: ValueInputOption = overrideOption ?? resolved.entry.valueInputOption;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      if (mode === "append") {
        return performWrite(deps, dedupeKey, mode, resolved.entry.slug, () =>
          deps.sheetsClient.appendValues(
            accessToken,
            resolved.entry.spreadsheetId,
            range,
            values,
            valueInputOption,
            undefined,
            ctx.signal,
          ),
        );
      }

      return performWrite(deps, dedupeKey, mode, resolved.entry.slug, () =>
        deps.sheetsClient.updateValues(
          accessToken,
          resolved.entry.spreadsheetId,
          range,
          values,
          valueInputOption,
          ctx.signal,
        ),
      );
    },
  };
}
