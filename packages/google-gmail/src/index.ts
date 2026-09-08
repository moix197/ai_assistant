export type { AccessTokenPort } from "./access-token-port";
export {
  createGmailClient,
  GmailApiError,
  type CreateGmailClientOptions,
  type GmailClient,
  type GmailListMessagesQuery,
  type GmailListMessagesResult,
  type GmailMessageMetadata,
  type GmailMessageRef,
} from "./gmail-client";
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
