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
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface ChannelCapabilities {
  markdown: boolean;
  files: boolean;
  buttons: boolean;
  maxMessageLength: number;
}

export interface Channel {
  readonly capabilities: ChannelCapabilities;
  /** Registers the single handler invoked for every inbound message. */
  subscribe(handler: InboundMessageHandler): void;
  send(target: string, text: string): Promise<void>;
}
