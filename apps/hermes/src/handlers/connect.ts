import type { Channel, InboundMessage } from "@hermes/channels";
import { type ConnectFlow, resolveConnectScopes } from "@hermes/google-auth";
import { CHANNEL_TELEGRAM } from "../agent/build-agent";

const USAGE_TEXT =
  "Usage: /connect google, /connect google sheets, /connect google calendar, or /connect google gmail";
/** Deployments with the Google all-or-none env group unset — Google features are cleanly absent, not a boot failure. */
const NOT_CONFIGURED_TEXT = "Google connect is not configured on this deployment.";

const SUPPORTED_PROVIDER = "google";

/**
 * `/connect google` and `/connect google sheets` — the only two supported
 * forms. The sub-argument after `"google"` (empty, or `"sheets"`) resolves
 * to a requested-scope list via `resolveConnectScopes`; anything else
 * (`/connect bogus`, `/connect google nonsense`, bare `/connect`) is handled
 * locally with a usage message and never reaches `connectFlow.startConnect`,
 * closing the paid-fallthrough hole `boot.ts`'s dispatcher argument parsing
 * fixes. `/disconnect` and `/status` are Phase 3's, not this handler's.
 */
export function createConnectHandler(
  channel: Channel,
  connectFlow: ConnectFlow | undefined,
): (message: InboundMessage, args: string) => Promise<void> {
  return async function handleConnect(message: InboundMessage, args: string): Promise<void> {
    const tokens = args.trim().split(/\s+/);
    const provider = tokens[0] ?? "";
    if (provider !== SUPPORTED_PROVIDER) {
      await channel.send(message.chatId, USAGE_TEXT);
      return;
    }

    const scopes = resolveConnectScopes(tokens.slice(1).join(" "));
    if (!scopes) {
      await channel.send(message.chatId, USAGE_TEXT);
      return;
    }

    if (!connectFlow) {
      await channel.send(message.chatId, NOT_CONFIGURED_TEXT);
      return;
    }

    const { url } = connectFlow.startConnect(
      CHANNEL_TELEGRAM,
      message.channelUserId,
      message.chatId,
      scopes,
    );
    await channel.send(message.chatId, url);
  };
}
