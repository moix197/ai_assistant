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

/**
 * Resolves the thread's newest message headers, then derives the reply's
 * recipient. The newest message's `From` is the reply target only when
 * someone else sent it — when the connected account itself sent the last
 * message (a normal back-and-forth, "send another one" after we spoke last),
 * `From` is our own address, so the recipient is that message's `To` instead
 * (the other party). Our own address (`from`) is always
 * `ctx.googleAccount.googleEmail`, never derived from thread headers. Then
 * builds the `Re:` subject and the `In-Reply-To`/`References` threading
 * headers, and composes the full `raw` message via `buildMimeMessage`. A
 * thread id Gmail 404s on refuses before any draft is saved, with
 * `thread_not_found`, same posture as `gmail-archive.ts`.
 */
interface ComposedDraft {
  ok: true;
  to: string;
  subject: string;
  body: string;
  raw: string;
}

async function composeDraft(
  deps: CreateGmailDraftReplyToolDeps,
  accessToken: string,
  args: Args,
  ctx: DraftReplyContext,
): Promise<ComposedDraft | ThreadNotFoundResult> {
  const { threadId, body } = args;

  let headers: Record<string, string>;
  try {
    headers = await findNewestMessageHeaders(deps, accessToken, threadId, ctx.signal);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return { ok: false, reason: "thread_not_found" };
    }
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

  return { ok: true, to, subject, body, raw };
}

/**
 * Creates or updates the Gmail draft per `draftId`'s presence. Returns the
 * resulting draft id so a following turn (e.g. "cambiá el viernes por el
 * lunes") can pass it back in as `draftId` and update the same draft rather
 * than create a second one, with no new inbound-correlation machinery.
 */
async function saveDraft(
  deps: CreateGmailDraftReplyToolDeps,
  accessToken: string,
  threadId: string,
  draftId: string | undefined,
  raw: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (draftId !== undefined) {
    await deps.gmailClient.updateDraft(accessToken, draftId, { threadId, raw }, signal);
    return draftId;
  }
  const created = await deps.gmailClient.createDraft(accessToken, { threadId, raw }, signal);
  return created.id;
}

/**
 * `gmail_draft_reply`: `requiresApproval: false` — saving or updating a
 * draft is reversible and inconsequential (visible and undoable in Gmail's
 * own Drafts folder), so this tool composes and saves it immediately,
 * without an approval prompt. `handler` does all the work that used to live
 * in a `prepare` hook (find the thread's newest message, derive the
 * recipient, compose the `raw` MIME message) immediately followed by the
 * `saveDraft` call, which dispatches to `updateDraft` (a `draftId` was
 * given) or `createDraft` (none was) — never both, never neither. This tool
 * never invokes any send endpoint: the whole point of it is that it cannot
 * send. Actually sending remains a separate, fully approval-gated call to
 * `gmail_send_draft`.
 */
export function createGmailDraftReplyTool(deps: CreateGmailDraftReplyToolDeps) {
  return {
    name: "gmail_draft_reply",
    description:
      "Saves a Gmail draft replying to a thread. Never sends anything, and saves/updates the draft immediately without asking for approval — it's reversible and visible/undoable in Gmail's own Drafts folder. Args: { threadId, body, draftId? } — threadId must come from a prior gmail_list_unread, gmail_search or gmail_read_thread call; body is the reply's plain-text content; draftId (returned by a prior gmail_draft_reply call) updates that same draft instead of creating a new one. Actually sending the draft still requires a separate, approved call to gmail_send_draft.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: DraftReplyContext): Promise<unknown> => {
      const { threadId, draftId } = args as Args;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        const composed = await composeDraft(deps, accessToken, args as Args, ctx);
        if (!composed.ok) return composed;
        const { to, subject, body, raw } = composed;

        const resultDraftId = await saveDraft(
          deps,
          accessToken,
          threadId,
          draftId,
          raw,
          ctx.signal,
        );
        return { ok: true, draftId: resultDraftId, to, subject, body };
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
        if (refusal) return refusal;
        throw error;
      }
    },
  };
}
