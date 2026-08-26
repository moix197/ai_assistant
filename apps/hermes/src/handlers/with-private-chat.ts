import type { InboundMessage, InboundMessageHandler } from "@hermes/channels";
import type { Logger } from "@hermes/core";

/**
 * Single non-private-chat gate, composed once in boot.ts around the command
 * dispatcher — same rationale as `withAllowlist`. Hermes is single-user: a
 * group/channel context is rejected even from an allowlisted sender, since
 * replying there broadcasts to everyone in it. This check originally lived
 * inline in `echo.ts`; once `/ping` and `/start` existed as separate
 * handlers that bypassed it, that became the exact fail-open-by-omission
 * risk `withAllowlist`'s own lift out of `echo.ts` already fixed once.
 */
export function withPrivateChat(
  handler: InboundMessageHandler,
  logger: Logger,
): (message: InboundMessage) => Promise<void> {
  return async function handleWithPrivateChat(message: InboundMessage): Promise<void> {
    const channelUserId = Number(message.channelUserId);

    if (message.chatType !== "private") {
      logger.warn("rejected: non-private chat", { channelUserId, chatType: message.chatType });
      return;
    }

    await handler(message);
  };
}
