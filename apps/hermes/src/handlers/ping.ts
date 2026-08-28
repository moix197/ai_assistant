import type { Channel, InboundMessage } from "@hermes/channels";
import type { Pool } from "@hermes/store";
import { checkDbConnectivity } from "../health";

/**
 * `/ping` — replies with process uptime and DB status. Reuses `/health`'s
 * `checkDbConnectivity` (Phase 1) rather than re-implementing the check.
 */
export function createPingHandler(
  channel: Channel,
  pool: Pool,
): (message: InboundMessage, args?: string) => Promise<void> {
  return async function handlePing(message: InboundMessage, _args?: string): Promise<void> {
    const dbConnected = await checkDbConnectivity(pool);
    const uptimeSeconds = Math.floor(process.uptime());
    const text = `pong\nuptime: ${uptimeSeconds}s\ndb: ${dbConnected ? "connected" : "disconnected"}`;
    await channel.send(message.chatId, text);
  };
}
