import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";

/**
 * Echoes back whatever the (already allowlist-checked, see
 * `with-allowlist.ts`) sender sends, in a private chat only.
 * `normalizeTelegramUpdate` (in `@hermes/channels`) has already dropped
 * anything with no sender id before this ever runs, so
 * `message.channelUserId` is always present here.
 */
export function createEchoHandler(
  channel: Channel,
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

    if (message.kind === "edited_message") {
      logger.info("edited message ignored", { channelUserId });
      return;
    }

    await channel.send(message.chatId, message.text);
  };
}
