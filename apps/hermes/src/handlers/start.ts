import type { Channel, InboundMessage } from "@hermes/channels";
import type { Pool } from "@hermes/store";
import { checkDbConnectivity } from "../health";

/**
 * `/start` — confirms allowlist membership and DB connectivity. Reaching
 * this handler at all already proves allowlist membership (see
 * `with-allowlist.ts`, composed around the dispatcher in boot.ts), so the
 * reply just needs to say so and report DB status via the same Phase 1
 * check `/ping` and `/health` use.
 */
export function createStartHandler(
  channel: Channel,
  pool: Pool,
): (message: InboundMessage) => Promise<void> {
  return async function handleStart(message: InboundMessage): Promise<void> {
    const dbConnected = await checkDbConnectivity(pool);
    const text = dbConnected
      ? "You're allowlisted and connected to the database."
      : "You're allowlisted, but the database is unreachable.";
    await channel.send(message.chatId, text);
  };
}
