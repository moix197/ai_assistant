import { z } from "zod/v4";
import { canonicalizeArgs, computeDedupeKey } from "../canonical-args";
import { GmailAmbiguousSendError, GmailApiError } from "../gmail-client";
import { htmlToText } from "../html-to-text";
import { toInsufficientScopeResult } from "../insufficient-scope";
import { decodePart, findBodyPart, readHeader } from "../mime";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const TOOL_NAME = "gmail_send_draft";

const schema = z.object({ draftId: z.string() });

type Args = z.infer<typeof schema>;

/**
 * `gmail.send` and `/connect google gmail-send` — same hardcoded posture as
 * `gmail-archive.ts`/`gmail-label.ts`/`gmail-draft-reply.ts` (this package
 * never imports `@hermes/google-auth`).
 */
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SEND_FIX = "run /connect google gmail-send";

/** How much of the body the approval prompt shows — mirrors `gmail-draft-reply.ts`'s own constant, duplicated here since that one is package-private (not exported), the same posture `canonical-args.ts`/`truncate.ts` document for cross-file duplication in this package. */
const BODY_PREVIEW_MAX_CHARS = 500;

/** Whitespace-collapsed, length-capped preview of the draft's body for the approval prompt's `items` — identical shape to `gmail-draft-reply.ts`'s `buildBodyPreview`. */
function buildBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length <= BODY_PREVIEW_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, BODY_PREVIEW_MAX_CHARS)}…`;
}

/**
 * The claim/complete/release port over `gmail_send_log`
 * (`@hermes/store`'s `gmail-send-log-repo.ts`) — declared here, the
 * consumer, per this codebase's consumer-declares-its-port convention
 * (`SheetWriteLogPort` follows the same shape). `apps/hermes/src/boot.ts`
 * binds this directly to `@hermes/store`'s
 * `recordGmailSendIntent`/`claimGmailSend`/`completeGmailSend`/
 * `releaseGmailSend`.
 *
 * `recordIntent` writes the `awaiting_approval` row `prepare` (below) calls
 * it from — an **intent**, never a claim and never a grant: `claim` only
 * ever transitions a row *out of* `awaiting_approval` (or inserts fresh), so
 * an `awaiting_approval` row is never itself a short-circuit for anything.
 */
export interface GmailSendLogClaimInput {
  channel: string;
  channelUserId: string;
  turnId: string;
  tool: string;
  canonicalArgs: unknown;
  draftId: string;
}

export interface GmailSendLogPort {
  recordIntent(dedupeKey: string, input: GmailSendLogClaimInput): Promise<void>;
  claim(
    dedupeKey: string,
    input: GmailSendLogClaimInput,
  ): Promise<"claimed" | { alreadyComplete: true; outcome: unknown } | { alreadyPending: true }>;
  complete(dedupeKey: string, outcome: unknown): Promise<void>;
  /**
   * Releases a still-`pending` claim after a *provably-definitive* send
   * failure — the request reached Google and was rejected outright, or
   * never got past quota enforcement — so a legitimate same-turn retry
   * isn't permanently blocked by `alreadyPending`'s fail-closed hedge over a
   * send that definitely never landed. Never called for a genuinely
   * ambiguous failure — the fail-safe default stays "when in doubt, hedge".
   */
  release?(dedupeKey: string): Promise<void>;
}

export interface CreateGmailSendDraftToolDeps extends GmailToolDeps {
  sendLogRepo: GmailSendLogPort;
}

/** `{ ok: false, reason: "draft_not_found" }` — refuses pre-prompt, before any intent is ever recorded, when the draft no longer exists (already sent, deleted, or never existed). */
export interface DraftNotFoundResult {
  ok: false;
  reason: "draft_not_found";
}

/** A claim finding an existing `pending` row for this exact key, or a post-send failure this client can't prove never reached Gmail — never retried; the caller must check Sent before trying again. */
export interface AmbiguousSendResult {
  ok: false;
  reason: "ambiguous_send";
  message: string;
}

const PENDING_CLAIM_MESSAGE = "puede que ya se haya enviado — revisá Enviados antes de reintentar";

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — just
 * enough for the handler to call `sendDraft` and describe the result; the
 * handler never re-fetches the draft or re-derives `to`/`subject`.
 */
export interface GmailSendDraftPlan {
  draftId: string;
  to: string;
  subject: string;
}

type SendDraftPrepareResult =
  | {
      ok: true;
      plan: GmailSendDraftPlan;
      summary: { action: string; target?: string; items: string[]; effects: string[] };
    }
  | { ok: false; result: DraftNotFoundResult | ReturnType<typeof toInsufficientScopeResult> };

/**
 * Extracts the draft's `to`/`subject` headers and a decoded body-text
 * preview via `getMessageFull` — the same `findBodyPart`/`decodePart`/
 * `htmlToText` pipeline `gmail_read_thread` uses for reading inbound mail,
 * minus `stripQuotedReply` (irrelevant here: this is our own composed
 * outbound draft, not a message with a quoted-reply chain to cut).
 */
async function readDraftPreview(
  deps: CreateGmailSendDraftToolDeps,
  accessToken: string,
  messageId: string,
  signal: AbortSignal | undefined,
): Promise<{ to: string; subject: string; bodyPreview: string }> {
  const full = await deps.gmailClient.getMessageFull(accessToken, messageId, signal);
  const to = readHeader(full.payload.headers, "To") ?? "";
  const subject = readHeader(full.payload.headers, "Subject") ?? "";

  const bodyPart = findBodyPart(full.payload);
  const decoded = bodyPart !== undefined ? decodePart(bodyPart) : "";
  const plainText = bodyPart?.mimeType === "text/html" ? htmlToText(decoded) : decoded;

  return { to, subject, bodyPreview: buildBodyPreview(plainText) };
}

/**
 * `prepare(args, ctx)`: fetches the draft (`getDraft`), refusing pre-prompt
 * — with **no intent row ever written** — if it no longer exists (already
 * sent, deleted, or never existed). Reads the draft's own `to`/`subject`/body
 * via `readDraftPreview` (above), builds the Spanish approval summary, then
 * — the one deliberate divergence from `sheets_write`'s `prepare`, which
 * claims nothing before approval — calls `sendLogRepo.recordIntent`,
 * writing the durable `awaiting_approval` row a post-restart report can read
 * even if the process crashes before a human ever taps a button. This is an
 * **intent**, not consent: nothing here calls `sendDraft`, and nothing
 * downstream may treat this row's existence as authorization.
 *
 * `prepare` re-fetches the draft fresh on every call, so an edit made
 * directly in the Gmail UI between `gmail_draft_reply` and `gmail_send_draft`
 * is exactly what gets shown and sent — never a stale cached copy.
 */
async function prepareSendDraft(
  deps: CreateGmailSendDraftToolDeps,
  args: unknown,
  ctx: GmailToolContext,
): Promise<SendDraftPrepareResult> {
  const { draftId } = args as Args;
  const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

  let draftMessageId: string;
  try {
    const draft = await deps.gmailClient.getDraft(accessToken, draftId, ctx.signal);
    draftMessageId = draft.message.id;
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return { ok: false, result: { ok: false, reason: "draft_not_found" } };
    }
    const refusal = toInsufficientScopeResult(error, GMAIL_SEND_SCOPE, GMAIL_SEND_FIX);
    if (refusal) return { ok: false, result: refusal };
    throw error;
  }

  const { to, subject, bodyPreview } = await readDraftPreview(
    deps,
    accessToken,
    draftMessageId,
    ctx.signal,
  );

  const canonicalArgsJson = canonicalizeArgs({ draftId });
  const dedupeKey = computeDedupeKey({
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgsJson,
  });
  await deps.sendLogRepo.recordIntent(dedupeKey, {
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgs: JSON.parse(canonicalArgsJson) as unknown,
    draftId,
  });

  return {
    ok: true,
    plan: { draftId, to, subject },
    summary: {
      action: "¿Enviar este correo?",
      target: `Para: ${to} — ${subject}`,
      items: [bodyPreview],
      effects: ["Se envía de verdad. Esto no se puede deshacer."],
    },
  };
}

/**
 * Resolves the dedupe key (byte-identical to how `prepare` computed it —
 * same `{ draftId }` canonical args, same `channel`/`channelUserId`/
 * `turnId`) and claims it, run by the handler only after a human has
 * approved. Returns `{ shortCircuit }` with the already-resolved outcome
 * when the claim short-circuits — `alreadyComplete`'s stored outcome
 * (**zero** further Gmail API calls) or `alreadyPending`'s structured
 * `ambiguous_send` hedge (writes nothing) — otherwise `{ dedupeKey }`, the
 * fresh claim this call now owns sending under.
 */
async function claimDedupeKey(
  deps: CreateGmailSendDraftToolDeps,
  parsed: Args,
  ctx: GmailToolContext,
): Promise<{ shortCircuit: unknown } | { dedupeKey: string }> {
  const canonicalArgsJson = canonicalizeArgs({ draftId: parsed.draftId });
  const dedupeKey = computeDedupeKey({
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgsJson,
  });

  const claimResult = await deps.sendLogRepo.claim(dedupeKey, {
    channel: ctx.channel,
    channelUserId: ctx.channelUserId,
    turnId: ctx.turnId,
    tool: TOOL_NAME,
    canonicalArgs: JSON.parse(canonicalArgsJson) as unknown,
    draftId: parsed.draftId,
  });
  if (typeof claimResult === "object" && "alreadyComplete" in claimResult) {
    return { shortCircuit: claimResult.outcome };
  }
  if (typeof claimResult === "object" && "alreadyPending" in claimResult) {
    return {
      shortCircuit: {
        ok: false,
        reason: "ambiguous_send",
        message: PENDING_CLAIM_MESSAGE,
      } satisfies AmbiguousSendResult,
    };
  }
  return { dedupeKey };
}

/**
 * `gmail_send_draft`: `requiresApproval: true` routes every call through the
 * approval gate before this handler ever runs. Order is load-bearing: claim
 * the dedupe key *first*, then call `sendDraft` — a same-turn retry
 * (identical `(channel, channelUserId, turnId, draftId)`) short-circuits on
 * the claim before ever calling Gmail a second time.
 *
 * The definitive-vs-ambiguous split, mirroring `sheets-write.ts`'s
 * `performWrite` exactly: a caught `GmailAmbiguousSendError` — thrown by
 * `sendDraft` only for a post-send timeout, a 5xx after the request left, or
 * a malformed body after a 2xx, never retried by the client — records and
 * returns the structured `ambiguous_send` hedge via `complete()` (so a
 * same-turn duplicate claim returns the same hedge without a second Gmail
 * call). A caught `GmailApiError` — only ever a non-429 4xx (rejected
 * outright) or an exhausted 429 (never got past quota enforcement) can
 * escape `sendDraft` as this type, per its own `classifySend` — releases the
 * still-pending claim before either returning the structured
 * `insufficient_scope` refusal (a 401/403) or rethrowing as a genuine fatal
 * error, so a legitimate same-turn retry isn't blocked hedging over a send
 * that provably never landed. Any other thrown error propagates with the
 * claim left pending — the fail-safe default.
 */
export function createGmailSendDraftTool(deps: CreateGmailSendDraftToolDeps) {
  return {
    name: TOOL_NAME,
    description:
      "Sends an existing Gmail draft. Args: { draftId } — draftId must come from a prior gmail_draft_reply call. Irreversible: once sent, the email is delivered and the draft is gone. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: GmailToolContext) => prepareSendDraft(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: GmailToolContext & { plan: GmailSendDraftPlan },
    ): Promise<unknown> => {
      const parsed = args as Args;
      const { plan } = ctx;

      const claim = await claimDedupeKey(deps, parsed, ctx);
      if ("shortCircuit" in claim) return claim.shortCircuit;
      const { dedupeKey } = claim;

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        const sent = await deps.gmailClient.sendDraft(accessToken, plan.draftId, ctx.signal);
        const outcome = {
          ok: true,
          messageId: sent.id,
          threadId: sent.threadId,
          to: plan.to,
          subject: plan.subject,
        };
        await deps.sendLogRepo.complete(dedupeKey, outcome);
        return outcome;
      } catch (error) {
        if (error instanceof GmailAmbiguousSendError) {
          const outcome: AmbiguousSendResult = {
            ok: false,
            reason: "ambiguous_send",
            message: error.message,
          };
          await deps.sendLogRepo.complete(dedupeKey, outcome);
          return outcome;
        }
        if (error instanceof GmailApiError) {
          // Definitive, not ambiguous: `gmail-client.ts`'s `classifySend`
          // only ever lets a `GmailApiError` escape `sendDraft` for a
          // non-429 4xx (thrown immediately — Google rejected the request
          // outright) or an exhausted 429 (thrown after retries — Google
          // never got past quota enforcement to apply it). Either way the
          // request never sent the mail, so the pending claim is released
          // rather than left to permanently hedge a legitimate same-turn
          // retry.
          await deps.sendLogRepo.release?.(dedupeKey);
          const refusal = toInsufficientScopeResult(error, GMAIL_SEND_SCOPE, GMAIL_SEND_FIX);
          if (refusal) return refusal;
          throw error;
        }
        // Any other thrown error (a network failure that can't be proven
        // pre-send, an unexpected exception, ...) falls through unreleased —
        // fail-safe stays "when in doubt, hedge".
        throw error;
      }
    },
  };
}
