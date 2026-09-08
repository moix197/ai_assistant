import { z } from "zod/v4";
import { toInsufficientScopeResult } from "../insufficient-scope";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const schema = z.object({
  query: z.string(),
  maxResults: z.number().int().min(1).max(25).default(10),
});

type Args = z.infer<typeof schema>;

/**
 * `gmail.readonly` and `/connect google gmail` — hardcoded here rather than
 * imported from `@hermes/google-auth`, same posture as `gmail-list-unread
 * .ts`'s `GMAIL_READ_SCOPE`/`GMAIL_READ_FIX` (this package never imports
 * `@hermes/google-auth`). Must stay in sync with that package's
 * `GMAIL_READ_SCOPES` value by hand.
 */
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_READ_FIX = "run /connect google gmail";

export type CreateGmailSearchToolDeps = GmailToolDeps;

export interface GmailSearchMessage {
  id: string;
  threadId: string;
  from?: string;
  subject?: string;
  date?: string;
  unread: boolean;
  important: boolean;
  snippet?: string;
}

/**
 * `gmail_search`: free-text search over the whole mailbox using Gmail's own
 * `q` operator syntax (`from:`, `newer_than:`, `has:attachment`, …) — passed
 * to `listMessages` verbatim, never rewritten. Returns the same bounded
 * metadata projection `gmail_list_unread` returns (sender/subject/date/
 * unread/important), plus each message's `snippet` — no body text; a match
 * worth reading in full goes to `gmail_read_thread` next. An empty result
 * set returns `{ok: true, messages: []}`, never an error, same as
 * `gmail_list_unread`.
 */
export function createGmailSearchTool(deps: CreateGmailSearchToolDeps) {
  return {
    name: "gmail_search",
    description:
      "Searches the user's Gmail using Gmail's own query syntax (e.g. 'from:sarah@example.com', 'newer_than:7d', 'has:attachment', 'subject:invoice'). Args: { query, maxResults? } — maxResults defaults to 10, max 25. Returns sender, subject, date, unread/important flags and a short snippet for each match — no message body; use gmail_read_thread to read a matching thread's full text.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: GmailToolContext): Promise<unknown> => {
      const { query, maxResults } = args as Args;

      try {
        const accessToken = await deps.accessTokenPort.getAccessToken(
          ctx.channel,
          ctx.channelUserId,
        );
        const { messages: refs } = await deps.gmailClient.listMessages(
          accessToken,
          { q: query },
          maxResults,
          ctx.signal,
        );

        const messages: GmailSearchMessage[] = [];
        for (const ref of refs) {
          const metadata = await deps.gmailClient.getMessageMetadata(
            accessToken,
            ref.id,
            ctx.signal,
          );
          messages.push({
            id: metadata.id,
            threadId: metadata.threadId,
            from: metadata.headers.From,
            subject: metadata.headers.Subject,
            date: metadata.headers.Date,
            unread: metadata.labelIds.includes("UNREAD"),
            important: metadata.labelIds.includes("IMPORTANT"),
            snippet: metadata.snippet || undefined,
          });
        }

        return { ok: true, messages };
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_READ_SCOPE, GMAIL_READ_FIX);
        if (refusal) return refusal;
        throw error;
      }
    },
  };
}
