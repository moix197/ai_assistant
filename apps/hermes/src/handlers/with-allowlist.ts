import { type InboundMessage, type InboundMessageHandler, isAllowed } from "@hermes/channels";
import type { Logger } from "@hermes/core";

/**
 * Single allowlist gate, composed once in boot.ts around the command
 * dispatcher. Phase 2 inlined this check in echo.ts, which was fine with one
 * handler; `/start` and `/ping` made it three, so each one re-implementing
 * the check became both duplication and a fail-open risk the moment one
 * forgot it.
 */
export function withAllowlist(
  handler: InboundMessageHandler,
  allowlist: Set<number>,
  logger: Logger,
): (message: InboundMessage) => Promise<void> {
  return async function handleWithAllowlist(message: InboundMessage): Promise<void> {
    const channelUserId = Number(message.channelUserId);

    if (!isAllowed(channelUserId, allowlist)) {
      logger.warn("rejected: unknown user", { channelUserId });
      return;
    }

    await handler(message);
  };
}
