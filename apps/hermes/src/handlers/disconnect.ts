import type { Channel, InboundMessage } from "@hermes/channels";
import type { GoogleAccountRepo } from "@hermes/google-auth";
import { CHANNEL_TELEGRAM } from "../agent/build-agent";

const DISCONNECTED_TEXT = "Disconnected.";

/**
 * `/disconnect` — thin wiring only, mirroring `stats.ts`'s shape. Takes no
 * arguments. Idempotent by construction: `deleteAccount` is a plain `DELETE
 * ... WHERE`, so a second call against an already-disconnected chat affects
 * zero rows and still replies the same confirming text, never a throw.
 */
export function createDisconnectHandler(
  channel: Channel,
  googleAccountRepo: GoogleAccountRepo,
): (message: InboundMessage, args?: string) => Promise<void> {
  return async function handleDisconnect(message: InboundMessage, _args?: string): Promise<void> {
    await googleAccountRepo.deleteAccount(CHANNEL_TELEGRAM, message.channelUserId);
    await channel.send(message.chatId, DISCONNECTED_TEXT);
  };
}
