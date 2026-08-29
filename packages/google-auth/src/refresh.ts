import { type Clock, systemClock } from "@hermes/core";
import type { GoogleAccount } from "./account-repo-port";
import type { RefreshAccessTokenPort } from "./oauth-client";
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
 * The only shape allowed onto `RefreshFailedError`'s `cause`. A gaxios
 * rejection carries the entire outgoing token request on `config.data` —
 * `client_secret` and the refresh token, form-encoded — and `util.inspect`
 * prints `[cause]` recursively, so a single `logger.error(err)`, an
 * `unhandledRejection` handler, or an error-reporting SDK anywhere in the
 * process would publish the secret. Typing `cause` as this extract instead of
 * `unknown` makes attaching the raw error a compile error rather than a
 * review catch.
 */
export interface RefreshErrorDetail {
  message: string;
  status?: number;
  /** Google's OAuth2 error code, e.g. `invalid_grant`. */
  error?: string;
  errorDescription?: string;
}

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

  constructor(
    reason: RefreshFailureReason,
    message: string,
    options?: { cause?: RefreshErrorDetail },
  ) {
    super(message, options);
    this.name = "RefreshFailedError";
    this.reason = reason;
  }
}

export interface RefreshCoordinatorDeps {
  /**
   * How a refresh token becomes a fresh access token. Injected so the
   * coordinator never depends on `google-auth-library` itself, and
   * **required**: an optional port with an `OAuth2Client` fallback made an
   * invalid combination (neither supplied) representable and deferred it to
   * a runtime throw. `apps/hermes/src/boot.ts` builds the production
   * implementation with `createGoogleRefreshAccessToken(oauthClient)`.
   */
  refreshAccessToken: RefreshAccessTokenPort;
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
   * the UPDATE-only `repo.updateRefreshedTokens`, never an upsert, so a
   * refresh in flight cannot resurrect an account that was disconnected
   * meanwhile). Concurrent calls for the same account share one
   * underlying refresh; the map entry is deleted in a `finally`, so a failed
   * refresh never poisons a later, independent attempt.
   */
  getValidAccessToken(account: GoogleAccount): Promise<GetValidAccessTokenResult>;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Decrypts `account.tokenEnvelope` and parses the resulting JSON into its
 * `{ accessToken, refreshToken }` shape — the one place that pairing lives,
 * shared by this module's own `decryptStoredTokens` below and
 * `apps/hermes/src/boot.ts`'s `buildDecryptRefreshToken` (the narrow decrypt
 * capability `/disconnect`'s handler needs). Throws whatever `openToken`
 * throws (`TokenDecryptError`) on a corrupt envelope or wrong key, uncaught
 * here — each caller decides how to react.
 */
export function decryptTokenEnvelope(account: GoogleAccount, cryptoKey: Buffer): StoredTokens {
  return JSON.parse(openToken(account.tokenEnvelope, cryptoKey)) as StoredTokens;
}

function accountKey(account: GoogleAccount): string {
  return `${account.channel}:${account.channelUserId}`;
}

function isStale(account: GoogleAccount, clock: Clock): boolean {
  return account.expiresAt.getTime() - clock.now().getTime() < REFRESH_SKEW_MS;
}

interface ErrorResponseShape {
  response?: {
    status?: number;
    data?: { error?: string; error_description?: string };
  };
}

/** The whitelist that keeps `config.data` — and the client secret in it — off `cause`. */
function toErrorDetail(error: unknown): RefreshErrorDetail {
  const response = (error as ErrorResponseShape | undefined)?.response;
  const detail: RefreshErrorDetail = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof response?.status === "number") detail.status = response.status;
  if (typeof response?.data?.error === "string") detail.error = response.data.error;
  if (typeof response?.data?.error_description === "string") {
    detail.errorDescription = response.data.error_description;
  }
  return detail;
}

function decryptStoredTokens(account: GoogleAccount, cryptoKey: Buffer): StoredTokens {
  try {
    return decryptTokenEnvelope(account, cryptoKey);
  } catch (error) {
    const reason = error instanceof TokenDecryptError ? "invalid_grant" : "transient";
    throw new RefreshFailedError(reason, "failed to decrypt stored token envelope", {
      cause: toErrorDetail(error),
    });
  }
}

/** Google's OAuth2 token endpoint reports a revoked/expired refresh token as `{ error: "invalid_grant" }` in the response body. */
function classifyRefreshRequestError(error: unknown): RefreshFailureReason {
  const data = (error as ErrorResponseShape | undefined)?.response?.data;
  return data?.error === "invalid_grant" ? "invalid_grant" : "transient";
}

/**
 * `createRefreshCoordinator` builds the single-flight `Map`, closed over by
 * every call — one map per coordinator instance, matching the one
 * coordinator `boot.ts` constructs for the process's lifetime. Correctness
 * depends on exactly one Hermes process ever running against a database
 * (`packages/store/src/advisory-lock.ts`); a second process would share
 * neither this map nor that guarantee. It is also the *only* in-process
 * de-duplication now: `OAuth2Client` keeps its own promise map keyed on the
 * refresh-token string, but that map is per-client, and the production port
 * builds a fresh client per call.
 */
export function createRefreshCoordinator(deps: RefreshCoordinatorDeps): RefreshCoordinator {
  const clock = deps.clock ?? systemClock;
  const { refreshAccessToken } = deps;
  const inFlight = new Map<string, Promise<GetValidAccessTokenResult>>();

  async function performRefresh(account: GoogleAccount): Promise<GetValidAccessTokenResult> {
    const stored = decryptStoredTokens(account, deps.cryptoKey);

    let refreshed: { accessToken: string; expiresAt: Date };
    try {
      refreshed = await refreshAccessToken(stored.refreshToken);
    } catch (error) {
      throw new RefreshFailedError(classifyRefreshRequestError(error), "refresh request failed", {
        cause: toErrorDetail(error),
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
