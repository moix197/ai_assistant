/**
 * Provider-neutral chat channel port. Every adapter (Telegram today; others
 * later) normalizes its wire format into this shape so handlers in
 * `apps/hermes` never need to know which platform a message came from.
 */

export type ChatType = "private" | "group" | "other";
export type InboundMessageKind = "message" | "edited_message";

export interface InboundMessage {
  /** Platform-specific sender id, e.g. Telegram's numeric user id as a string. */
  channelUserId: string;
  /** Platform-specific chat id to reply into. */
  chatId: string;
  text: string;
  chatType: ChatType;
  kind: InboundMessageKind;
  /**
   * The platform's own update id (Telegram's `update_id`). Required, not
   * optional: a missing `updateId` would make `apps/hermes/src/handlers/
   * complete.ts`'s dedupe key collapse to the same literal string
   * (`telegram:undefined`) for every such message, silently short-circuiting
   * an unrelated later message with a stored reply meant for someone else.
   * Exists specifically so a paid handler can derive a stable dedupe key —
   * see `packages/channels/README.md`.
   */
  updateId: number;
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

/**
 * A normalized inbound button tap (Telegram's `callback_query`), alongside
 * the existing inbound-message kind `subscribe` emits — added in Phase 3
 * (`plans/03-agent-core.md`) for the approval gate's Approve/Deny buttons.
 */
export interface InboundCallback {
  /** The platform's own callback id — required to answer it (`answerCallback`). */
  callbackId: string;
  /** The opaque data carried on the tapped button (an approval id, for this PRD's only user). */
  callbackData: string;
  /** The chat the originating message lives in, so a reply/edit can target it. */
  chatId: string;
  /** The message the tapped button was attached to — needed for `editMessage`. */
  messageId: string;
  /** Platform-specific sender id, e.g. Telegram's numeric user id as a string. */
  channelUserId: string;
}

export type InboundCallbackHandler = (callback: InboundCallback) => void | Promise<void>;

export interface ChannelCapabilities {
  markdown: boolean;
  files: boolean;
  buttons: boolean;
  maxMessageLength: number;
}

/** One row of inline-keyboard buttons — `send`'s `options.buttons` is rows of these. */
export interface SendButton {
  label: string;
  callbackData: string;
}

export interface SendOptions {
  /** Only honored by a channel whose `capabilities.buttons` is true. */
  buttons?: SendButton[][];
}

export interface Channel {
  readonly capabilities: ChannelCapabilities;
  /** Registers the single handler invoked for every inbound message. */
  subscribe(handler: InboundMessageHandler): void;
  /**
   * Registers the single handler invoked for every inbound button tap.
   * Optional: added in Phase 3 alongside `editMessage`/`answerCallback`
   * below, so a channel (or a test's mock `Channel`) that predates inline
   * keyboards is unaffected — only a channel whose `capabilities.buttons` is
   * true is expected to implement it.
   */
  subscribeCallback?(handler: InboundCallbackHandler): void;
  /**
   * Replies into `target` (the channel-specific chat id). `options.buttons`,
   * when given, attaches an inline keyboard — only meaningful on a channel
   * whose `capabilities.buttons` is true. Returns the sent message's id, so
   * a caller can later `editMessage` it (e.g. to show a resolved approval
   * state). Additive over the pre-Phase-3 shape: existing callers that pass
   * no `options` and ignore the return value are unaffected.
   */
  send(target: string, text: string, options?: SendOptions): Promise<{ messageId: string }>;
  /**
   * Edits a previously sent message in place — used to make an approval
   * prompt's buttons inert once resolved. Optional for the same reason as
   * `subscribeCallback` above.
   */
  editMessage?(target: string, messageId: string, text: string): Promise<void>;
  /**
   * Acknowledges a button tap (Telegram requires every `callback_query` to
   * be answered, with or without a visible toast). Optional for the same
   * reason as `subscribeCallback` above.
   */
  answerCallback?(callbackId: string, text?: string): Promise<void>;
}
