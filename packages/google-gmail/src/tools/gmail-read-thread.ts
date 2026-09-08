import { z } from "zod/v4";
import { htmlToText } from "../html-to-text";
import { toInsufficientScopeResult } from "../insufficient-scope";
import type { GmailMessagePart } from "../mime";
import { decodePart, findBodyPart, readHeader } from "../mime";
import { stripQuotedReply } from "../strip-quoted-reply";
import { MAX_BODY_CHARS_PER_MESSAGE, measureMessage, truncateBySize } from "../truncate";
import type { GmailToolContext, GmailToolDeps } from "./tool-deps";

const schema = z.object({
  threadId: z.string(),
});

type Args = z.infer<typeof schema>;

/**
 * Same posture as `gmail-search.ts`'s own constants — hardcoded rather than
 * imported from `@hermes/google-auth` (this package never imports it).
 */
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_READ_FIX = "run /connect google gmail";

/**
 * Every mail body this tool has to omit for lack of room — this tool takes
 * no offset/pagination argument, so the note says what was left out rather
 * than inviting a retry it cannot honor (`.ai/decisions/
 * bounded-tool-results.md`).
 */
const TRUNCATED_NOTE =
  "Este hilo tiene más mensajes de los que se muestran aquí — se devolvieron los más recientes; los mensajes más antiguos no están incluidos en este resultado.";

export type CreateGmailReadThreadToolDeps = GmailToolDeps;

export interface GmailThreadMessage {
  id: string;
  from?: string;
  to?: string;
  date?: string;
  text: string;
  bodyTruncated?: true;
}

function capMessageBody(text: string, limit: number): { text: string; bodyTruncated: boolean } {
  if (text.length <= limit) return { text, bodyTruncated: false };
  return { text: text.slice(0, limit), bodyTruncated: true };
}

/**
 * The body pipeline, as four separately-testable pure functions composed
 * here rather than one blob: `decodePart` (MIME decode) → `htmlToText`
 * (only for an HTML body part) → `stripQuotedReply` → `capMessageBody`
 * (applied *after* HTML→text and quote-stripping, never before — capping
 * raw HTML would spend the whole budget on markup).
 */
function extractMessageText(payload: GmailMessagePart | undefined): {
  text: string;
  bodyTruncated: boolean;
} {
  const bodyPart = findBodyPart(payload);
  if (bodyPart === undefined) return { text: "", bodyTruncated: false };

  const decoded = decodePart(bodyPart);
  const plainText = bodyPart.mimeType === "text/html" ? htmlToText(decoded) : decoded;
  const stripped = stripQuotedReply(plainText);
  return capMessageBody(stripped, MAX_BODY_CHARS_PER_MESSAGE);
}

/**
 * `gmail_read_thread`: fetches a thread's message refs, orders them
 * newest-first, and applies the per-thread message cap via `truncateBySize`
 * (`measureMessage(0)` — a message-count-only cap at this stage, before any
 * body has been fetched or measured) so the fan-out over `getMessageFull`
 * below is bounded *before* those gets are issued, not after (Dependencies
 * & Risks: this is the tool most likely to press the 30s timeout budget on
 * a large thread). Only the kept messages are fetched and run through the
 * body pipeline. `truncated`/`returnedMessages`/`totalMessages`/`note` are
 * additive via conditional spread — an untruncated thread's result carries
 * none of them.
 */
export function createGmailReadThreadTool(deps: CreateGmailReadThreadToolDeps) {
  return {
    name: "gmail_read_thread",
    description:
      "Reads a Gmail thread's messages in full, newest first. Args: { threadId }. Returns each message's sender, recipient, date and extracted body text (HTML converted to plain text, quoted history stripped). Long threads are capped to the most recent messages, each message's text capped in length.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: GmailToolContext): Promise<unknown> => {
      const { threadId } = args as Args;

      try {
        const accessToken = await deps.accessTokenPort.getAccessToken(
          ctx.channel,
          ctx.channelUserId,
        );
        const thread = await deps.gmailClient.getThread(accessToken, threadId, ctx.signal);

        const sortedRefs = [...thread.messages].sort(
          (a, b) => Number(b.internalDate) - Number(a.internalDate),
        );
        const capped = truncateBySize(sortedRefs, () => measureMessage(0));

        const messages: GmailThreadMessage[] = [];
        let subject: string | undefined;

        for (const ref of capped.items) {
          const full = await deps.gmailClient.getMessageFull(accessToken, ref.id, ctx.signal);
          const headers = full.payload.headers;
          if (subject === undefined) subject = readHeader(headers, "Subject");

          const { text, bodyTruncated } = extractMessageText(full.payload);

          messages.push({
            id: full.id,
            from: readHeader(headers, "From"),
            to: readHeader(headers, "To"),
            date: readHeader(headers, "Date"),
            text,
            ...(bodyTruncated && { bodyTruncated: true as const }),
          });
        }

        return {
          ok: true,
          threadId,
          subject,
          messages,
          ...(capped.truncated && {
            truncated: true,
            returnedMessages: capped.returnedCount,
            totalMessages: capped.totalCount,
            note: TRUNCATED_NOTE,
          }),
        };
      } catch (error) {
        const refusal = toInsufficientScopeResult(error, GMAIL_READ_SCOPE, GMAIL_READ_FIX);
        if (refusal) return refusal;
        throw error;
      }
    },
  };
}
