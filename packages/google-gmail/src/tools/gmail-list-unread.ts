import { z } from "zod/v4";
import { toInsufficientScopeResult } from "../insufficient-scope";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const schema = z.object({
  maxResults: z.number().int().min(1).max(25).default(10),
});

type Args = z.infer<typeof schema>;

/**
 * `gmail.readonly` and `/connect google gmail` — hardcoded here rather than
 * imported from `@hermes/google-auth`'s `GMAIL_READ_SCOPES`/
 * `describeConnectCommand`, since this package never imports
 * `@hermes/google-auth` at all (consumer-declares-its-port convention). Must
 * stay in sync with that package's `GMAIL_READ_SCOPES` value by hand.
 */
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_READ_FIX = "run /connect google gmail";

export type CreateGmailListUnreadToolDeps = GmailToolDeps;

export interface GmailUnreadMessage {
  id: string;
  threadId: string;
  from?: string;
  subject?: string;
  date?: string;
  unread: boolean;
  important: boolean;
}

/**
 * `gmail_list_unread`: lists unread inbox messages (`labelIds: ["UNREAD",
 * "INBOX"]`), then fetches metadata (no body) for each to project sender,
 * subject, date, and unread/important flags. `maxResults` defaults to 10,
 * capped at 25 — this phase ships no pagination. An empty inbox returns
 * `{ok: true, messages: []}`, never an error. A `GmailApiError` with status
 * 401/403 (a scope revoked at Google after `withRequiredScopes` already
 * gated this call on a granted one) is caught and mapped to the structured
 * `insufficient_scope` refusal via `toInsufficientScopeResult`, so the model
 * relays a clean refusal instead of a raw error; any other error rethrows.
 */
export function createGmailListUnreadTool(deps: CreateGmailListUnreadToolDeps) {
  return {
    name: "gmail_list_unread",
    description:
      "Lists unread messages in the user's Gmail inbox. Args: { maxResults? } — maxResults defaults to 10, max 25. Returns sender, subject, date and unread/important flags for each message — no message body.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: GmailToolContext): Promise<unknown> => {
      const { maxResults } = args as Args;

      try {
        const accessToken = await deps.accessTokenPort.getAccessToken(
          ctx.channel,
          ctx.channelUserId,
        );
        const { messages: refs } = await deps.gmailClient.listMessages(
          accessToken,
          { labelIds: ["UNREAD", "INBOX"] },
          maxResults,
          ctx.signal,
        );

        const messages: GmailUnreadMessage[] = [];
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
