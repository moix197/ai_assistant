import { type Channel, type InboundMessage, isAllowed } from "@hermes/channels";
import type { Logger } from "@hermes/core";

/**
 * The bot's only handler this phase: echo back whatever an allowlisted user
 * sends, in a private chat only. `normalizeTelegramUpdate` (in
 * `@hermes/channels`) has already dropped anything with no sender id before
 * this ever runs, so `message.channelUserId` is always present here.
 */
export function createEchoHandler(
  channel: Channel,
  allowlist: Set<number>,
  logger: Logger,
): (message: InboundMessage) => Promise<void> {
  return async function handleInboundMessage(message: InboundMessage): Promise<void> {
    const channelUserId = Number(message.channelUserId);

    // Hermes is single-user: a group/channel context is rejected even from
    // an allowlisted sender, since replying there broadcasts to everyone in it.
    if (message.chatType !== "private") {
      logger.warn("rejected: non-private chat", { channelUserId, chatType: message.chatType });
      return;
    }

    if (!isAllowed(channelUserId, allowlist)) {
      logger.warn("rejected: unknown user", { channelUserId });
      return;
    }

    if (message.kind === "edited_message") {
      logger.info("edited message ignored", { channelUserId });
      return;
    }

    await channel.send(message.chatId, message.text);
  };
}
