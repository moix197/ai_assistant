import type { Clock } from "@hermes/core";
import type { OAuth2Client } from "google-auth-library";
import type { GoogleAccount, GoogleAccountRepo } from "./account-repo-port";
import { buildAuthUrl, exchangeCode } from "./oauth-client";
import type { PendingConnection, PendingConnectionStore } from "./pending-connections";
import { generatePkcePair } from "./pkce";
import { IDENTITY_SCOPES, hasRequiredScopes } from "./scopes";
import { type TokenEnvelope, sealToken } from "./token-crypto";

export interface ConnectFlowDeps {
  oauthClient: OAuth2Client;
  repo: GoogleAccountRepo;
  cryptoKey: Buffer;
  pendingStore: PendingConnectionStore;
  clock: Clock;
}

export interface StartConnectResult {
  url: string;
  state: string;
}

export type CompleteConnectResult =
  | { ok: true; email: string; chatId: string }
  | { ok: false; reason: "invalid_state" }
  | { ok: false; reason: "missing_scopes" };

interface SealedTokens {
  envelope: TokenEnvelope;
  expiresAt: Date;
  email: string;
  grantedScopes: string[];
}

export interface ConnectFlow {
  startConnect: (
    channel: string,
    channelUserId: string,
    chatId: string,
    scopes: string[],
  ) => StartConnectResult;
  completeConnect: (state: string, code: string) => Promise<CompleteConnectResult>;
}

/**
 * OAuth2 + PKCE + state-nonce connect flow (Dependencies & Risks). Never
 * touches the agent loop or `@hermes/channels` — command handlers in
 * `apps/hermes` call `startConnect`, the OAuth callback route calls
 * `completeConnect`. Tokens never leave this module unsealed: `code` and the
 * raw access/refresh tokens appear in no log line and no return value here.
 */
export function createConnectFlow(deps: ConnectFlowDeps): ConnectFlow {
  function startConnect(
    channel: string,
    channelUserId: string,
    chatId: string,
    scopes: string[],
  ): StartConnectResult {
    const { verifier, challenge } = generatePkcePair();
    const state = deps.pendingStore.createPendingConnection({
      channel,
      channelUserId,
      chatId,
      scopes,
      verifier,
    });
    const url = buildAuthUrl(deps.oauthClient, { scopes, state, codeChallenge: challenge });
    return { url, state };
  }

  function validatePendingConnection(state: string): PendingConnection | undefined {
    return deps.pendingStore.consumePendingConnection(state);
  }

  /** Exchanges `code` for tokens and seals both into one envelope — never returns them unsealed. */
  async function exchangeAndSealTokens(
    pending: PendingConnection,
    code: string,
  ): Promise<SealedTokens> {
    const exchanged = await exchangeCode(deps.oauthClient, { code, verifier: pending.verifier });
    const email = exchanged.idTokenClaims.email;
    if (typeof email !== "string" || email === "") {
      throw new Error("exchangeAndSealTokens: id token carried no email claim");
    }
    const envelope = sealToken(
      JSON.stringify({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
      }),
      deps.cryptoKey,
    );
    return {
      envelope,
      expiresAt: exchanged.expiresAt,
      email,
      grantedScopes: exchanged.grantedScopes,
    };
  }

  async function persistAccount(pending: PendingConnection, sealed: SealedTokens): Promise<void> {
    const account: GoogleAccount = {
      channel: pending.channel,
      channelUserId: pending.channelUserId,
      chatId: pending.chatId,
      googleEmail: sealed.email,
      scopes: sealed.grantedScopes,
      tokenEnvelope: sealed.envelope,
      expiresAt: sealed.expiresAt,
    };
    await deps.repo.upsertAccount(account);
  }

  async function completeConnect(state: string, code: string): Promise<CompleteConnectResult> {
    const pending = validatePendingConnection(state);
    if (!pending) return { ok: false, reason: "invalid_state" };

    const sealed = await exchangeAndSealTokens(pending, code);
    // Google's granular-consent screen lets a user deselect individual
    // checkboxes, so a grant narrower than `IDENTITY_SCOPES` is a real
    // outcome — and one no row should be written for: a half-connected
    // account would pass every later `hasRequiredScopes` check and only fail
    // as a 403 from Google at tool-call time.
    if (!hasRequiredScopes(sealed.grantedScopes, IDENTITY_SCOPES)) {
      return { ok: false, reason: "missing_scopes" };
    }

    await persistAccount(pending, sealed);
    return { ok: true, email: sealed.email, chatId: pending.chatId };
  }

  return { startConnect, completeConnect };
}
