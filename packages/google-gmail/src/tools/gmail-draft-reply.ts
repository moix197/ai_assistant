import { z } from "zod/v4";
import { buildMimeMessage } from "../build-mime-message";
import { GmailApiError } from "../gmail-client";
import { toInsufficientScopeResult } from "../insufficient-scope";
import { type ThreadNotFoundResult, newestRef } from "./gmail-archive";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const schema = z.object({
  threadId: z.string(),
  body: z.string(),
  draftId: z.string().optional(),
});

type Args = z.infer<typeof schema>;

/**
 * `gmail.modify` and `/connect google gmail-send` — same hardcoded posture
 * as `gmail-archive.ts`/`gmail-label.ts` (this package never imports
 * `@hermes/google-auth`). `drafts.create`/`drafts.update` accept
 * `gmail.modify` per Google's per-method scope table, so this tool rides the
 * existing write tier rather than requesting `gmail.compose` — no new
 * connect-tier scope (see the plan's "This tool requires the write tier"
 * note).
 */
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_WRITE_FIX = "run /connect google gmail-send";

/** How much of the body the approval prompt shows — whitespace-collapsed so a body full of blank lines doesn't blow the preview budget on newlines. */
const BODY_PREVIEW_MAX_CHARS = 500;

export type CreateGmailDraftReplyToolDeps = GmailToolDeps;

/**
 * `GmailToolContext` plus `ctx.googleAccount` — `withRequiredScopes`
 * (`apps/hermes/src/agent/with-required-scopes.ts`) injects the real value at
 * runtime for every scope-gated Gmail tool, but `GmailToolContext` itself
 * never declared the field, so it was silently available and never read.
 * Declared locally per this package's consumer-declares-its-own-port
 * convention (`GmailToolContext` above) rather than importing
 * `@hermes/google-auth`'s `GoogleAccount` — only the one field this tool
 * needs.
 */
type DraftReplyContext = GmailToolContext & { googleAccount: { googleEmail: string } };

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` —
 * critically including `raw`, the fully-composed MIME message. `handler`
 * posts `plan.raw` verbatim and never calls `buildMimeMessage` itself: the
 * bytes a human approved are structurally the bytes Gmail saves, not a
 * convention (`.ai/decisions/tool-prepare-hook.md`).
 */
export interface GmailDraftReplyPlan {
  threadId: string;
  /** Present for an update (the caller supplied one); absent for a create. */
  draftId?: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  raw: string;
}

type DraftReplyPrepareResult =
  | {
      ok: true;
      plan: GmailDraftReplyPlan;
      summary: { action: string; target?: string; items?: string[]; effects: string[] };
    }
  | { ok: false; result: ThreadNotFoundResult | ReturnType<typeof toInsufficientScopeResult> };

/**
 * Reuses `gmail-archive.ts`'s `newestRef` (CLAUDE.md: reuse before reinvent)
 * to find the thread's newest message, then reads its headers via
 * `getMessageMetadata` — the same From/To/Subject/Message-ID set
 * `gmail-archive.ts`/`gmail-label.ts` already fetch, so this needs no new
 * client method beyond the draft ones.
 */
async function findNewestMessageHeaders(
  deps: CreateGmailDraftReplyToolDeps,
  accessToken: string,
  threadId: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, string>> {
  const thread = await deps.gmailClient.getThread(accessToken, threadId, signal);
  const ref = newestRef(thread.messages);
  const metadata = await deps.gmailClient.getMessageMetadata(accessToken, ref.id, signal);
  return metadata.headers;
}

/**
 * The bare address out of a header value that may be a plain address
 * (`user@example.com`) or a display-name form
 * (`Display Name <user@example.com>`) — lowercased, for case-insensitive
 * comparison only. The caller keeps the original formatted header value for
 * anything that ends up in composed `to`/`from` fields; this extraction is
 * never used to build message content.
 */
function extractEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  const address = match?.[1] ?? headerValue;
  return address.trim().toLowerCase();
}

/** `"Re: <subject>"`, unless the original subject already starts with "Re:" (case-insensitive) — never double-prefixed. */
function buildReplySubject(original: string | undefined): string {
  const subject = (original ?? "").trim();
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Whitespace-collapsed, length-capped preview of the reply body for the approval prompt's `items`. */
function buildBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length <= BODY_PREVIEW_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, BODY_PREVIEW_MAX_CHARS)}…`;
}

/**
 * `prepare(args, ctx)`: resolves the thread's newest message headers, then
 * derives the reply's recipient. The newest message's `From` is the reply
 * target only when someone else sent it — when the connected account itself
 * sent the last message (a normal back-and-forth, "send another one" after
 * we spoke last), `From` is our own address, so the recipient is that
 * message's `To` instead (the other party). Our own address (`from`) is
 * always `ctx.googleAccount.googleEmail`, never derived from thread headers.
 * Then builds the `Re:` subject and the `In-Reply-To`/`References` threading
 * headers, and composes the full `raw` message **here** via
 * `buildMimeMessage` — the one and only place this tool ever builds it. A
 * thread id Gmail 404s on refuses before any prompt with
 * `thread_not_found`, same posture as `gmail-archive.ts`.
 */
async function prepareDraftReply(
  deps: CreateGmailDraftReplyToolDeps,
  args: unknown,
  ctx: DraftReplyContext,
): Promise<DraftReplyPrepareResult> {
  const { threadId, body, draftId } = args as Args;
  const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

  let headers: Record<string, string>;
  try {
    headers = await findNewestMessageHeaders(deps, accessToken, threadId, ctx.signal);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return { ok: false, result: { ok: false, reason: "thread_not_found" } };
    }
    const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
    if (refusal) return { ok: false, result: refusal };
    throw error;
  }

  const from = ctx.googleAccount.googleEmail;
  const newestSender = headers.From ?? "";
  const sentByOwnAccount = extractEmailAddress(newestSender) === extractEmailAddress(from);
  const to = sentByOwnAccount ? (headers.To ?? "") : newestSender;
  const subject = buildReplySubject(headers.Subject);
  const inReplyTo = headers["Message-ID"];
  const references = inReplyTo;

  const raw = buildMimeMessage({ from, to, subject, body, inReplyTo, references });

  return {
    ok: true,
    plan: { threadId, draftId, to, subject, body, inReplyTo, references, raw },
    summary: {
      action:
        draftId !== undefined ? "¿Actualizar el borrador?" : "¿Guardar este borrador de respuesta?",
      target: `Para: ${to} — ${subject}`,
      items: [buildBodyPreview(body)],
      effects: ["Se guarda como borrador en Gmail. No se envía nada todavía."],
    },
  };
}

/**
 * Creates or updates the Gmail draft per `plan.draftId`'s presence, posting
 * `plan.raw` exactly as `prepare` composed it — no recomposition. Returns
 * the resulting draft id so a following turn (e.g. "cambiá el viernes por el
 * lunes") can pass it back in as `draftId` and update the same draft rather
 * than create a second one, with no new inbound-correlation machinery.
 */
async function saveDraft(
  deps: CreateGmailDraftReplyToolDeps,
  accessToken: string,
  plan: GmailDraftReplyPlan,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (plan.draftId !== undefined) {
    await deps.gmailClient.updateDraft(
      accessToken,
      plan.draftId,
      { threadId: plan.threadId, raw: plan.raw },
      signal,
    );
    return plan.draftId;
  }
  const created = await deps.gmailClient.createDraft(
    accessToken,
    { threadId: plan.threadId, raw: plan.raw },
    signal,
  );
  return created.id;
}

/**
 * `gmail_draft_reply`: `requiresApproval: true` — every call routes through
 * the approval gate before `handler` ever runs. `handler` reads `ctx.plan`
 * (built by `prepare`) and calls `saveDraft`, which dispatches to
 * `updateDraft` (a `draftId` was given) or `createDraft` (none was) — never
 * both, never neither. This tool never invokes any send endpoint: the whole
 * point of it is that it cannot send.
 */
export function createGmailDraftReplyTool(deps: CreateGmailDraftReplyToolDeps) {
  return {
    name: "gmail_draft_reply",
    description:
      "Saves a Gmail draft replying to a thread. Never sends anything. Args: { threadId, body, draftId? } — threadId must come from a prior gmail_list_unread, gmail_search or gmail_read_thread call; body is the reply's plain-text content; draftId (returned by a prior gmail_draft_reply call) updates that same draft instead of creating a new one. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: DraftReplyContext) => prepareDraftReply(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: DraftReplyContext & { plan: GmailDraftReplyPlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        const draftId = await saveDraft(deps, accessToken, plan, ctx.signal);
        return { ok: true, draftId, to: plan.to, subject: plan.subject, body: plan.body };
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
        if (refusal) return refusal;
        throw error;
      }
    },
  };
}
