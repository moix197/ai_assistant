import type { Logger } from "@hermes/core";
import { z } from "zod/v4";
import { canonicalizeArgs, computeDedupeKey } from "../canonical-args";
import { type ResolveSheetResult, resolveSheet } from "../resolve-sheet";
import {
  SheetsAmbiguousWriteError,
  SheetsApiError,
  type SheetsValuesResult,
  type SheetsWriteResult,
  type ValueInputOption,
} from "../sheets-client";
import { measureRow, truncateBySize, truncateForPrompt } from "../truncate";
import { detectValueInputConsequence } from "../value-input-consequence";
import type { SheetsToolContext, SheetsToolDeps } from "./tool-deps";

/** Used when a caller supplies no `logger` — mirrors `packages/llm`'s `openai-compatible.ts` `NOOP_LOGGER` convention (this package has no logging mechanism of its own to reuse; see `sheets-client.ts`, which has none either). */
const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TOOL_NAME = "sheets_write";

const cellValue = z.union([z.string(), z.number(), z.boolean()]);
const valuesSchema = z.array(z.array(cellValue));
const valueInputOptionSchema = z.enum(["RAW", "USER_ENTERED"]).optional();

/**
 * A flat `z.object`, not `z.discriminatedUnion("mode", [...])` — the two
 * modes have identical field sets (only the `mode` literal differs), so the
 * union bought no extra validation, but its JSON Schema conversion
 * (`z.toJSONSchema` in `packages/agent/src/prompt.ts`) emits a top-level
 * `anyOf` with no `type: "object"`, which OpenAI-compatible providers (e.g.
 * DeepSeek) reject outright — and since every tool schema is sent on every
 * completion request, that one malformed schema failed every turn, not just
 * writes. See `apps/hermes/src/agent/__tests__/tool-schemas.test.ts`.
 */
const schema = z.object({
  mode: z.enum(["append", "update"]),
  sheet: z.string(),
  range: z.string(),
  values: valuesSchema,
  valueInputOption: valueInputOptionSchema,
});

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
  /** Receives the update-mode pre-overwrite snapshot read's non-fatal-failure warning (Phase 7). Default: a no-op logger. */
  logger?: Logger;
}

/** `{ ok: false, reason: "read_only_sheet" }` — the write-specific refusal `sheets_inspect`/`sheets_read` never need, since any registered `access` permits a read. */
export interface ReadOnlySheetResult {
  ok: false;
  reason: "read_only_sheet";
}

/**
 * What `prepare` resolves and threads onto `ctx.plan` for the handler
 * (`06-legible-approvals-bounded-reads` Phase 3) — everything the handler
 * needs to finish the write without ever re-resolving the slug itself. No
 * `access` field: `prepare` itself refuses a `read`-access sheet (Phase 4,
 * below) before a plan is ever built, so by the time a plan exists its
 * sheet is provably `readwrite` — nothing downstream needs to re-check it.
 */
export interface SheetsWritePlan {
  sheetSlug: string;
  spreadsheetId: string;
  effectiveValueInputOption: ValueInputOption;
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

/** Row-preview cap for the approval prompt (`06-legible-approvals-bounded-reads` Phase 5) — a tool-side content decision, not a gate-side rendering one. */
const ROW_PREVIEW_MAX_ROWS = 3;
const ROW_PREVIEW_CHAR_LIMIT = 100;

const APPEND_MODE_EFFECT = "Agrega una fila nueva al final. No cambia nada de lo existente.";
const UPDATE_MODE_EFFECT = "Sobrescribe una fila que ya existe.";

/**
 * The approval prompt's mode-specific question line — never the A1 `range`
 * (settled decision 22), so `update`'s summary never leaks A1 notation. Uses
 * natural Spanish singular/plural agreement (`una fila` / `N filas`) rather
 * than the literal `fila(s)` placeholder, per the phase's own success-
 * criteria examples (`¿Agregar una fila a Clients?`, `¿Reemplazar una fila en
 * Clients?`) — both modes spell out the singular ("una") and use numerals
 * only for the plural count, for consistency between them.
 */
function buildWriteAction(mode: "append" | "update", rowCount: number, slug: string): string {
  if (mode === "append") {
    return rowCount === 1
      ? `¿Agregar una fila a ${slug}?`
      : `¿Agregar ${rowCount} filas a ${slug}?`;
  }
  if (rowCount === 1) {
    return `¿Reemplazar una fila en ${slug}?`;
  }
  return `¿Reemplazar ${rowCount} filas en ${slug}?`;
}

/**
 * Joins one row's cells (comma-separated), then hands the joined string to
 * `truncateForPrompt` to collapse whitespace runs (including newlines/tabs)
 * and cap it at `ROW_PREVIEW_CHAR_LIMIT` — truncation happens per row, after
 * joining, never per cell, so a row of many short cells still truncates as
 * one unit. Collapsing whitespace *before* truncating is load-bearing: a
 * cell value containing a newline would otherwise inject extra lines into
 * the rendered approval prompt, letting a crafted cell forge prompt-looking
 * content the user never actually approved.
 */
function formatRowPreview(row: Array<string | number | boolean>): string {
  const joined = row.map((cell) => String(cell)).join(", ");
  return truncateForPrompt(joined, ROW_PREVIEW_CHAR_LIMIT);
}

/**
 * The first `ROW_PREVIEW_MAX_ROWS` rows as preview lines, plus `itemsTotal`
 * — omitted for the zero-row edge case (an empty `values` array, schema-
 * permitted but degenerate) so the renderer's own `itemsTotal > items.length`
 * check never fires a "…y N más" line for nothing to count. `itemsTotal` is
 * otherwise always `values.length`, even when every row is already shown,
 * per this phase's plan: the renderer's inequality check is the single
 * source of truth for whether to print the count line.
 */
function buildRowItems(
  values: Array<Array<string | number | boolean>>,
): { items: string[] } | { items: string[]; itemsTotal: number } {
  const items = values.slice(0, ROW_PREVIEW_MAX_ROWS).map(formatRowPreview);
  return values.length > 0 ? { items, itemsTotal: values.length } : { items };
}

export interface SheetsWriteSuccessResult {
  ok: true;
  sheet: string;
  mode: "append" | "update";
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
  /**
   * `mode: "update"` only: the range's values immediately before this write
   * overwrote them (Phase 7), truncated via the shared `truncateBySize`
   * helper. Absent for `mode: "append"` (never read) and absent when the
   * snapshot read itself failed (non-fatal — the write still completes).
   */
  replaced?: unknown[][];
  truncated?: boolean;
  returnedRows?: number;
  totalRows?: number;
}

/** The subset of `SheetsWriteSuccessResult` `captureReplacedSnapshot` (below) can populate — merged into the eventual success outcome, never present on its own. */
type ReplacedSnapshot = Pick<
  SheetsWriteSuccessResult,
  "replaced" | "truncated" | "returnedRows" | "totalRows"
>;

/**
 * Shared by both modes' branches below: calls `callApi` (the mode-specific
 * `appendValues`/`updateValues` invocation), then resolves the dedupe claim
 * one of three ways — a caught `SheetsAmbiguousWriteError` records and
 * returns the structured hedge; a caught `SheetsApiError` releases the still
 * -pending claim before rethrowing (see the definitive-vs-ambiguous split in
 * the handler's own doc comment above); any other thrown error propagates
 * with the claim left pending. On success, records and returns the
 * `SheetsWriteSuccessResult` — the success-outcome-plus-`complete()` shape
 * both `append` and `update` previously duplicated inline. `successExtras`
 * (Phase 7's `replaced` snapshot, `update`-only) is merged into the outcome
 * before it's recorded via `complete()`, so `replaced` lands in
 * `sheet_write_log` for free — the whole outcome is what gets stored.
 */
async function performWrite(
  deps: CreateSheetsWriteToolDeps,
  dedupeKey: string,
  mode: "append" | "update",
  sheetSlug: string,
  callApi: () => Promise<SheetsWriteResult>,
  successExtras?: ReplacedSnapshot,
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
    ...successExtras,
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
 * `mode: "update"` only: snapshots the target range's current values
 * immediately before the write overwrites them (`06-legible-approvals-
 * bounded-reads` Phase 7) — a single call to `sheetsClient.getValues`, with
 * no retry loop of its own here. That call still routes through
 * `sheets-client.ts`'s `getWithRetry` like every other read, so a 429/5xx on
 * this specific request can still incur that shared client's normal
 * rate-limit/transient retry delay before this function ever sees the
 * failure — this function itself just doesn't add a second layer of retries
 * on top. Wrapped so a failure never blocks the write itself: caught, logged
 * via `warn`, and swallowed — the caller gets `undefined` and proceeds
 * unaffected. On success, runs the result through the same `truncateBySize`
 * helper `sheets_read`/`sheets_inspect` use, measuring each row identically,
 * so a huge existing range doesn't balloon the tool result.
 */
async function captureReplacedSnapshot(
  deps: CreateSheetsWriteToolDeps,
  logger: Logger,
  accessToken: string,
  plan: SheetsWritePlan,
  range: string,
  signal: AbortSignal,
): Promise<ReplacedSnapshot | undefined> {
  let snapshot: SheetsValuesResult;
  try {
    snapshot = await deps.sheetsClient.getValues(
      accessToken,
      plan.spreadsheetId,
      range,
      "FORMATTED_VALUE",
      signal,
    );
  } catch (error) {
    logger.warn("sheets_write: pre-overwrite snapshot read failed, proceeding without `replaced`", {
      sheet: plan.sheetSlug,
      range,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const rows = snapshot.values ?? [];
  const capped = truncateBySize(rows, measureRow);

  return {
    replaced: capped.items,
    ...(capped.truncated && {
      truncated: true,
      returnedRows: capped.returnedCount,
      totalRows: capped.totalCount,
    }),
  };
}

/**
 * `mode: "update"`'s branch of the handler below: captures the pre-overwrite
 * snapshot (above), then delegates to `performWrite` the same way the
 * `append` branch does, merging the snapshot into the eventual success
 * outcome.
 */
async function performUpdateWrite(
  deps: CreateSheetsWriteToolDeps,
  logger: Logger,
  dedupeKey: string,
  plan: SheetsWritePlan,
  range: string,
  values: Array<Array<string | number | boolean>>,
  valueInputOption: ValueInputOption,
  accessToken: string,
  signal: AbortSignal,
): Promise<SheetsWriteSuccessResult | AmbiguousWriteResult> {
  const replacedSnapshot = await captureReplacedSnapshot(
    deps,
    logger,
    accessToken,
    plan,
    range,
    signal,
  );
  return performWrite(
    deps,
    dedupeKey,
    "update",
    plan.sheetSlug,
    () =>
      deps.sheetsClient.updateValues(
        accessToken,
        plan.spreadsheetId,
        range,
        values,
        valueInputOption,
        signal,
      ),
    replacedSnapshot,
  );
}

/**
 * Resolves the target sheet and builds the `plan`/`summary` the approval
 * prompt needs — the only step of the write pipeline that runs before a
 * human ever sees anything (`06-legible-approvals-bounded-reads` Phase 3).
 * `args` is already parsed by the loop (`packages/agent/src/loop.ts`'s
 * `prepareGatedCall`). Checks `access` right after resolving the slug
 * (`06-legible-approvals-bounded-reads` Phase 4): a `read`-access sheet is
 * refused here, with the unchanged `read_only_sheet` shape, *before* any
 * approval prompt is sent — closing the "asked to approve something already
 * destined to fail" defect Phase 3 deliberately left open (see that plan's
 * Dependencies & Risks). This mirrors how an unknown slug already refuses
 * before a prompt; now both `resolveSheet` failure modes do.
 */
async function prepareWrite(
  deps: CreateSheetsWriteToolDeps,
  args: unknown,
  ctx: SheetsToolContext,
): Promise<
  | { ok: false; result: Extract<ResolveSheetResult, { ok: false }> | ReadOnlySheetResult }
  | {
      ok: true;
      plan: SheetsWritePlan;
      summary: {
        action: string;
        target?: string;
        items: string[];
        itemsTotal?: number;
        effects: string[];
      };
    }
> {
  const parsed = args as z.infer<typeof schema>;
  const resolved = await resolveSheet(deps.sheetRegistry, parsed.sheet);
  if (!resolved.ok) {
    return { ok: false, result: resolved };
  }

  const { entry } = resolved;
  if (entry.access !== "readwrite") {
    return {
      ok: false,
      result: { ok: false, reason: "read_only_sheet" } satisfies ReadOnlySheetResult,
    };
  }

  const effectiveValueInputOption: ValueInputOption =
    parsed.valueInputOption ?? entry.valueInputOption;

  const rowCount = parsed.values.length;
  const modeEffect = parsed.mode === "append" ? APPEND_MODE_EFFECT : UPDATE_MODE_EFFECT;
  const valueInputConsequence = detectValueInputConsequence(
    parsed.values,
    effectiveValueInputOption,
  );

  return {
    ok: true,
    plan: {
      sheetSlug: entry.slug,
      spreadsheetId: entry.spreadsheetId,
      effectiveValueInputOption,
    },
    summary: {
      action: buildWriteAction(parsed.mode, rowCount, entry.slug),
      target: entry.description || undefined,
      ...buildRowItems(parsed.values),
      effects: [modeEffect, ...(valueInputConsequence ? [valueInputConsequence] : [])],
    },
  };
}

/**
 * `sheets_write`: appends or overwrites rows in a registered spreadsheet.
 * `requiresApproval: true` routes every call through the approval gate
 * before this handler ever runs; `prepare` (above) resolves the slug and
 * enforces `access === "readwrite"` ahead of the prompt
 * (`06-legible-approvals-bounded-reads` Phase 4), so this handler reads
 * `ctx.plan` instead of re-resolving or re-checking access — by the time
 * this handler runs, the sheet is provably `readwrite`. Order inside the
 * handler is still load-bearing: claim the dedupe key, *then* call the
 * Sheets API — a same-turn retry (identical `(channel, channelUserId,
 * turnId, tool, canonical args)`) short-circuits on the claim before ever
 * calling the client a second time.
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
 * (`packages/agent`'s `invokeToolHandler` turns a thrown handler error into
 * the tool-result message itself, settled decision 15), leaving its claim
 * pending rather than released.
 */
export function createSheetsWriteTool(deps: CreateSheetsWriteToolDeps) {
  const logger = deps.logger ?? NOOP_LOGGER;
  return {
    name: TOOL_NAME,
    description:
      "Writes rows to a registered spreadsheet by slug. Args: { mode: 'append' | 'update', sheet, range, values, valueInputOption? }. 'append' adds new rows after the given range; 'update' overwrites the exact range given. values is a 2D array (rows of cells). Only permitted against a sheet registered with readwrite access. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: SheetsToolContext) => prepareWrite(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: SheetsToolContext & { plan: SheetsWritePlan },
    ): Promise<unknown> => {
      const parsed = args as z.infer<typeof schema>;
      const { mode, range, values } = parsed;
      const { plan } = ctx;

      const claim = await claimDedupeKey(deps, parsed, ctx);
      if ("shortCircuit" in claim) return claim.shortCircuit;
      const { dedupeKey } = claim;

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      if (mode === "append") {
        return performWrite(deps, dedupeKey, mode, plan.sheetSlug, () =>
          deps.sheetsClient.appendValues(
            accessToken,
            plan.spreadsheetId,
            range,
            values,
            plan.effectiveValueInputOption,
            undefined,
            ctx.signal,
          ),
        );
      }

      return performUpdateWrite(
        deps,
        logger,
        dedupeKey,
        plan,
        range,
        values,
        plan.effectiveValueInputOption,
        accessToken,
        ctx.signal,
      );
    },
  };
}
