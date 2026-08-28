import type { Channel, InboundMessage } from "@hermes/channels";
import type { GoogleAccountRepo } from "@hermes/google-auth";
import { CHANNEL_TELEGRAM } from "../agent/build-agent";

const NOT_CONNECTED_TEXT = "Not connected. Run /connect google to connect.";

/**
 * `/status` — thin wiring only, per CLAUDE.md's thin-entry-points rule and
 * `stats.ts`'s shape: no LLM call, just a read and a reply. Scopes are read
 * from the stored `google_accounts` row (`account.scopes`), not from
 * `TOOL_REQUIRED_SCOPES` — the row is what was actually granted, the
 * registry is only what a given tool requires.
 */
export function createStatusHandler(
  channel: Channel,
  googleAccountRepo: GoogleAccountRepo,
): (message: InboundMessage, args?: string) => Promise<void> {
  return async function handleStatus(message: InboundMessage, _args?: string): Promise<void> {
    const account = await googleAccountRepo.getAccount(CHANNEL_TELEGRAM, message.channelUserId);
    if (!account) {
      await channel.send(message.chatId, NOT_CONNECTED_TEXT);
      return;
    }
    await channel.send(
      message.chatId,
      `Connected as ${account.googleEmail}, scopes: ${account.scopes.join(" ")}`,
    );
  };
}
