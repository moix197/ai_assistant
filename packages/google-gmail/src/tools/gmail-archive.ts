import { z } from "zod/v4";
import { GmailApiError } from "../gmail-client";
import type { GmailThreadMessageRef } from "../gmail-client";
import { toInsufficientScopeResult } from "../insufficient-scope";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const schema = z.object({
  threadId: z.string(),
});

type Args = z.infer<typeof schema>;

/**
 * `gmail.modify` and `/connect google gmail-send` — hardcoded here rather
 * than imported from `@hermes/google-auth`'s `GMAIL_WRITE_SCOPES` (this
 * package never imports `@hermes/google-auth`, the consumer-declares-its-
 * port convention every other Gmail tool follows). Must stay in sync with
 * that package's `GMAIL_WRITE_SCOPES` first member by hand.
 */
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_WRITE_FIX = "run /connect google gmail-send";

export type CreateGmailArchiveToolDeps = GmailToolDeps;

/** `{ ok: false, reason: "thread_not_found" }` — a threadId Gmail 404s on, refused before any approval prompt is built. */
export interface ThreadNotFoundResult {
  ok: false;
  reason: "thread_not_found";
}

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — the
 * newest message's id, the one `modifyMessage` actually targets (Gmail's
 * `INBOX` label is per-message; archiving here means removing it from the
 * thread's most recent message, the same message `prepare` already read for
 * the prompt), plus `threadId`/`subject` for the eventual result payload.
 * `handler` never re-resolves any of it.
 */
export interface GmailArchivePlan {
  threadId: string;
  messageId: string;
  subject?: string;
}

type ArchivePrepareResult =
  | {
      ok: true;
      plan: GmailArchivePlan;
      summary: { action: string; target?: string; effects: string[] };
    }
  | { ok: false; result: ThreadNotFoundResult | ReturnType<typeof toInsufficientScopeResult> };

/**
 * `.reduce` without an initial value, not a sort-then-index — under this
 * repo's `noUncheckedIndexedAccess`, indexing a sorted array's `[0]` types as
 * possibly `undefined`; `reduce`'s no-initial-value overload types as always
 * defined (and throws at runtime for a genuinely empty array — a `getThread`
 * response Gmail itself never sends for a real thread).
 */
export function newestRef(messages: GmailThreadMessageRef[]): GmailThreadMessageRef {
  return messages.reduce((newest, candidate) =>
    Number(candidate.internalDate) > Number(newest.internalDate) ? candidate : newest,
  );
}

/**
 * Fetches the thread, finds its newest message ref (same comparison
 * `gmail_read_thread`'s sort uses), and reads that message's metadata for
 * the subject/id the prompt and plan need — one thread read plus one
 * metadata read, no body fetched.
 */
async function findNewestMessage(
  deps: CreateGmailArchiveToolDeps,
  accessToken: string,
  threadId: string,
  signal: AbortSignal | undefined,
): Promise<{ id: string; subject?: string }> {
  const thread = await deps.gmailClient.getThread(accessToken, threadId, signal);
  const ref = newestRef(thread.messages);
  const metadata = await deps.gmailClient.getMessageMetadata(accessToken, ref.id, signal);
  return { id: metadata.id, subject: metadata.headers.Subject };
}

/**
 * `prepare(args, ctx)`: resolves the thread's newest message — subject for
 * the prompt, id for the handler — before ever building an approval prompt.
 * A 404 on the thread id fails closed with `thread_not_found`, no prompt for
 * a nonexistent thread, same posture as Calendar's `cancel_event`. A scope
 * revoked at Google after `withRequiredScopes`'s pre-check surfaces as the
 * structured `insufficient_scope` refusal, same as every read tool's handler.
 */
async function prepareArchive(
  deps: CreateGmailArchiveToolDeps,
  args: unknown,
  ctx: GmailToolContext,
): Promise<ArchivePrepareResult> {
  const { threadId } = args as Args;
  const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

  let newest: { id: string; subject?: string };
  try {
    newest = await findNewestMessage(deps, accessToken, threadId, ctx.signal);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return { ok: false, result: { ok: false, reason: "thread_not_found" } };
    }
    const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
    if (refusal) return { ok: false, result: refusal };
    throw error;
  }

  return {
    ok: true,
    plan: { threadId, messageId: newest.id, subject: newest.subject },
    summary: {
      action: "¿Archivar esta conversación?",
      target: newest.subject,
      effects: ["Sale de Recibidos. Sigue disponible en Todos los mensajes."],
    },
  };
}

/**
 * `gmail_archive`: `requiresApproval: true` — every call routes through the
 * approval gate before `handler` ever runs. `handler` reads `ctx.plan`
 * (built by `prepare`) and calls `modifyMessage` with exactly the planned
 * message id, removing `INBOX`. `modifyMessage` is idempotent (Gmail's own
 * label semantics), so re-archiving an already-archived thread is a
 * harmless no-op — this is the evidence backing the no-durable-log decision
 * recorded in Phase 6, unlike `gmail_send_draft`.
 */
export function createGmailArchiveTool(deps: CreateGmailArchiveToolDeps) {
  return {
    name: "gmail_archive",
    description:
      "Archives a Gmail thread (removes it from the inbox, still available in All Mail). Args: { threadId } — threadId must come from a prior gmail_list_unread, gmail_search or gmail_read_thread call. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: GmailToolContext) => prepareArchive(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: GmailToolContext & { plan: GmailArchivePlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        await deps.gmailClient.modifyMessage(
          accessToken,
          plan.messageId,
          { removeLabelIds: ["INBOX"] },
          ctx.signal,
        );
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_MODIFY_SCOPE, GMAIL_WRITE_FIX);
        if (refusal) return refusal;
        throw error;
      }

      return { ok: true, threadId: plan.threadId, subject: plan.subject };
    },
  };
}
