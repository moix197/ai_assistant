export type { AccessTokenPort } from "./access-token-port";
export {
  createGmailClient,
  GmailApiError,
  type CreateGmailClientOptions,
  type GmailClient,
  type GmailListMessagesQuery,
  type GmailListMessagesResult,
  type GmailMessageFull,
  type GmailMessageMetadata,
  type GmailMessageRef,
  type GmailThread,
  type GmailThreadMessageRef,
} from "./gmail-client";
export {
  decodeBase64Url,
  decodePart,
  decodePartText,
  decodeQuotedPrintable,
  findBodyPart,
  readHeader,
  type GmailMessageHeader,
  type GmailMessagePart,
  type GmailMessagePartBody,
} from "./mime";
export { htmlToText } from "./html-to-text";
export { stripQuotedReply } from "./strip-quoted-reply";
export {
  MAX_BODY_CHARS_PER_MESSAGE,
  MAX_THREAD_MESSAGES,
  measureMessage,
  truncateBySize,
  type TruncateBySizeCaps,
  type TruncateBySizeResult,
} from "./truncate";
export {
  toInsufficientScopeResult,
  type InsufficientScopeResult,
} from "./insufficient-scope";
export type { GmailToolContext, GmailToolDeps } from "./tools/tool-deps";
export {
  createGmailListUnreadTool,
  type CreateGmailListUnreadToolDeps,
  type GmailUnreadMessage,
} from "./tools/gmail-list-unread";
export {
  createGmailSearchTool,
  type CreateGmailSearchToolDeps,
  type GmailSearchMessage,
} from "./tools/gmail-search";
export {
  createGmailReadThreadTool,
  type CreateGmailReadThreadToolDeps,
  type GmailThreadMessage,
} from "./tools/gmail-read-thread";
