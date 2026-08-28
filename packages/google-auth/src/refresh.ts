import { type Clock, systemClock } from "@hermes/core";
import type { OAuth2Client } from "google-auth-library";
import type { GoogleAccount } from "./account-repo-port";
import { refreshAccessToken } from "./oauth-client";
import { TokenDecryptError, openToken, sealToken } from "./token-crypto";

/**
 * How close to `expiresAt` counts as "needs refresh" — the single source of
 * truth for that notion. `apps/hermes/src/google/refresh-sweep.ts`'s
 * `listAccountsExpiringBefore` cutoff imports and reuses this exact constant
 * rather than hardcoding its own duration, so the sweep's "expiring soon"
 * query and this function's staleness check can never drift into two
 * independently-tuned numbers. 10 minutes — deliberately double
 * `REFRESH_SWEEP_INTERVAL_MS` (5 minutes), so one missed or slow sweep tick
 * still leaves a full interval of buffer before a token actually expires.
 */
export const REFRESH_SKEW_MS = 10 * 60_000;

export type RefreshFailureReason = "invalid_grant" | "transient";

/**
 * Thrown by `getValidAccessToken` when a refresh attempt fails.
 * `reason: "invalid_grant"` covers both Google's `invalid_grant` response
 * (a revoked or expired refresh token) and a stored envelope that fails to
 * decrypt — both leave the account unusable until the operator re-runs
 * `/connect google`, so both drive the same disconnect-and-alert action in
 * `refresh-sweep.ts`. `reason: "transient"` is everything else (network
 * failure, a 5xx from Google) — worth retrying on the next sweep tick
 * without touching the stored account.
 */
export class RefreshFailedError extends Error {
  readonly reason: RefreshFailureReason;

  constructor(reason: RefreshFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RefreshFailedError";
    this.reason = reason;
  }
}

export interface RefreshCoordinatorDeps {
  oauthClient: OAuth2Client;
  cryptoKey: Buffer;
  /** Defaults to `systemClock`; overridden by tests that need control over "now". */
  clock?: Clock;
}

export interface GetValidAccessTokenResult {
  accessToken: string;
  account: GoogleAccount;
}

/**
 * The single seam every caller that needs a live Google access token goes
 * through — the boot-owned sweep (`refresh-sweep.ts`) this phase, and any
 * future request-path tool call. Neither has (or should ever grow) a second
 * "force refresh" entry point.
 */
export interface RefreshCoordinator {
  /**
   * Fresh (`expiresAt` well outside `REFRESH_SKEW_MS`): decrypts and returns
   * the cached access token unchanged, `account` returned as given — zero
   * network calls. Stale: refreshes through the single-flight map keyed on
   * `(channel, channelUserId)` and returns the updated account (**not
   * persisted** — that's the caller's job; `refresh-sweep.ts` persists via
   * `repo.upsertAccount`). Concurrent calls for the same account share one
   * underlying refresh; the map entry is deleted in a `finally`, so a failed
   * refresh never poisons a later, independent attempt.
   */
  getValidAccessToken(account: GoogleAccount): Promise<GetValidAccessTokenResult>;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

function accountKey(account: GoogleAccount): string {
  return `${account.channel}:${account.channelUserId}`;
}

function isStale(account: GoogleAccount, clock: Clock): boolean {
  return account.expiresAt.getTime() - clock.now().getTime() < REFRESH_SKEW_MS;
}

function decryptStoredTokens(account: GoogleAccount, cryptoKey: Buffer): StoredTokens {
  try {
    return JSON.parse(openToken(account.tokenEnvelope, cryptoKey)) as StoredTokens;
  } catch (error) {
    const reason = error instanceof TokenDecryptError ? "invalid_grant" : "transient";
    throw new RefreshFailedError(reason, "failed to decrypt stored token envelope", {
      cause: error,
    });
  }
}

/** Google's OAuth2 token endpoint reports a revoked/expired refresh token as `{ error: "invalid_grant" }` in the response body. */
function classifyRefreshRequestError(error: unknown): RefreshFailureReason {
  const data = (error as { response?: { data?: { error?: string } } } | undefined)?.response?.data;
  return data?.error === "invalid_grant" ? "invalid_grant" : "transient";
}

/**
 * `createRefreshCoordinator` builds the single-flight `Map`, closed over by
 * every call — one map per coordinator instance, matching the one
 * coordinator `boot.ts` constructs for the process's lifetime. Correctness
 * depends on exactly one Hermes process ever running against a database
 * (`packages/store/src/advisory-lock.ts`); a second process would share
 * neither this map nor that guarantee.
 */
export function createRefreshCoordinator(deps: RefreshCoordinatorDeps): RefreshCoordinator {
  const clock = deps.clock ?? systemClock;
  const inFlight = new Map<string, Promise<GetValidAccessTokenResult>>();

  async function performRefresh(account: GoogleAccount): Promise<GetValidAccessTokenResult> {
    const stored = decryptStoredTokens(account, deps.cryptoKey);

    let refreshed: { accessToken: string; expiresAt: Date };
    try {
      refreshed = await refreshAccessToken(deps.oauthClient, stored.refreshToken);
    } catch (error) {
      throw new RefreshFailedError(classifyRefreshRequestError(error), "refresh request failed", {
        cause: error,
      });
    }

    const envelope = sealToken(
      JSON.stringify({ accessToken: refreshed.accessToken, refreshToken: stored.refreshToken }),
      deps.cryptoKey,
    );
    const account_: GoogleAccount = {
      ...account,
      tokenEnvelope: envelope,
      expiresAt: refreshed.expiresAt,
    };
    return { accessToken: refreshed.accessToken, account: account_ };
  }

  function refreshSingleFlight(account: GoogleAccount): Promise<GetValidAccessTokenResult> {
    const key = accountKey(account);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = performRefresh(account).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function getValidAccessToken(account: GoogleAccount): Promise<GetValidAccessTokenResult> {
    if (!isStale(account, clock)) {
      const stored = decryptStoredTokens(account, deps.cryptoKey);
      return { accessToken: stored.accessToken, account };
    }
    return refreshSingleFlight(account);
  }

  return { getValidAccessToken };
}
