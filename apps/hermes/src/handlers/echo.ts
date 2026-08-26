import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";

/**
 * Echoes back whatever the (already allowlist- and private-chat-checked,
 * see `with-allowlist.ts` and `with-private-chat.ts`) sender sends.
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

    if (message.kind === "edited_message") {
      logger.info("edited message ignored", { channelUserId });
      return;
    }

    await channel.send(message.chatId, message.text);
  };
}
