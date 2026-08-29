import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { type GoogleAccount, type GoogleAccountRepo, revokeToken } from "@hermes/google-auth";
import { CHANNEL_TELEGRAM } from "../agent/build-agent";

const DISCONNECTED_TEXT = "Disconnected.";

export interface DisconnectHandlerDeps {
  /**
   * Decrypts a connected account's stored token envelope down to its
   * refresh token, so this handler can revoke the grant at Google before
   * deleting the local row. `undefined` when Google's OAuth env group is
   * unset — `/disconnect` then just deletes locally, the same behavior as
   * before this phase. Throws (propagated from `openToken`'s
   * `TokenDecryptError`) on a corrupt envelope or wrong key; caught inside
   * this handler, never by the caller — a decrypt failure must not block
   * the local delete either.
   */
  decryptRefreshToken: ((account: GoogleAccount) => string) | undefined;
  logger: Logger;
  /** Boot-lifetime shutdown signal, forwarded to `revokeToken` so a shutdown aborts an in-flight revoke instead of leaving it to run out its retry budget unstoppable. `undefined` in tests that don't care. */
  signal?: AbortSignal;
}

/**
 * Best-effort revoke-before-delete: any reason not to revoke (Google
 * unconfigured, no connected account, a `getAccount` read failure, a decrypt
 * failure) is swallowed here, and `revokeToken` itself never throws either —
 * so `createDisconnectHandler` always reaches `deleteAccount`/the same
 * success reply regardless of whether the grant was actually revoked at
 * Google.
 */
async function revokeGrantIfConnected(
  googleAccountRepo: GoogleAccountRepo,
  message: InboundMessage,
  deps: DisconnectHandlerDeps,
): Promise<void> {
  if (!deps.decryptRefreshToken) return;

  let refreshToken: string;
  try {
    const account = await googleAccountRepo.getAccount(CHANNEL_TELEGRAM, message.channelUserId);
    if (!account) return;
    refreshToken = deps.decryptRefreshToken(account);
  } catch (error) {
    deps.logger.warn(
      "failed to look up account or decrypt refresh token for revoke; deleting local account anyway",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return;
  }
  await revokeToken(refreshToken, { logger: deps.logger, externalSignal: deps.signal });
}

/**
 * `/disconnect` — revokes the OAuth grant at Google (best-effort, never
 * blocking), then removes the sender's `google_accounts` row and confirms.
 * Idempotent by construction: `deleteAccount` is a plain `DELETE ... WHERE`,
 * so a second call against an already-disconnected chat finds no account to
 * revoke, affects zero rows, and still replies the same confirming text,
 * never a throw.
 */
export function createDisconnectHandler(
  channel: Channel,
  googleAccountRepo: GoogleAccountRepo,
  deps: DisconnectHandlerDeps,
): (message: InboundMessage, args?: string) => Promise<void> {
  return async function handleDisconnect(message: InboundMessage, _args?: string): Promise<void> {
    await revokeGrantIfConnected(googleAccountRepo, message, deps);
    await googleAccountRepo.deleteAccount(CHANNEL_TELEGRAM, message.channelUserId);
    await channel.send(message.chatId, DISCONNECTED_TEXT);
  };
}
