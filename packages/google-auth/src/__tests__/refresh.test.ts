import type { Clock } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccount } from "../account-repo-port";
import type { RefreshAccessTokenPort } from "../oauth-client";
import {
  REFRESH_SKEW_MS,
  type RefreshErrorDetail,
  RefreshFailedError,
  createRefreshCoordinator,
} from "../refresh";
import { type TokenEnvelope, openToken, sealToken } from "../token-crypto";

const CRYPTO_KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-08-28T00:00:00.000Z");

function envelopeFor(tokens: { accessToken: string; refreshToken: string }): TokenEnvelope {
  return sealToken(JSON.stringify(tokens), CRYPTO_KEY);
}

function account(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "user-1",
    chatId: "chat-1",
    googleEmail: "person@example.com",
    scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    tokenEnvelope: envelopeFor({ accessToken: "cached-access", refreshToken: "cached-refresh" }),
    expiresAt: NOW,
    ...overrides,
  };
}

function fixedClock(now: Date = NOW): Clock {
  return { now: () => now };
}

/**
 * Mocks the port this package owns, never `OAuth2Client`'s internals — the
 * coordinator's only dependency for turning a refresh token into an access
 * token is this function type.
 */
function coordinatorWith(refreshAccessToken: RefreshAccessTokenPort) {
  return createRefreshCoordinator({
    refreshAccessToken,
    cryptoKey: CRYPTO_KEY,
    clock: fixedClock(),
  });
}

function staleAccount(): GoogleAccount {
  return account({ expiresAt: new Date(NOW.getTime() + 60_000) });
}

describe("createRefreshCoordinator", () => {
  it("returns the cached token unchanged for a fresh account, calling the refresh port zero times", async () => {
    const refreshAccessToken = vi.fn();
    const coordinator = coordinatorWith(refreshAccessToken);
    const freshAccount = account({ expiresAt: new Date(NOW.getTime() + REFRESH_SKEW_MS + 60_000) });

    const result = await coordinator.getValidAccessToken(freshAccount);

    expect(result.accessToken).toBe("cached-access");
    expect(result.account).toBe(freshAccount);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes a stale account and reseals with a fresh IV", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue({
      accessToken: "new-access",
      expiresAt: new Date(NOW.getTime() + 3600_000),
    });
    const coordinator = coordinatorWith(refreshAccessToken);
    const stale = staleAccount();

    const result = await coordinator.getValidAccessToken(stale);

    expect(result.accessToken).toBe("new-access");
    expect(refreshAccessToken).toHaveBeenCalledWith("cached-refresh");
    expect(result.account.tokenEnvelope.iv).not.toBe(stale.tokenEnvelope.iv);
    expect(result.account.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));
    expect(
      JSON.parse(openToken(result.account.tokenEnvelope, CRYPTO_KEY)) as {
        accessToken: string;
        refreshToken: string;
      },
    ).toEqual({ accessToken: "new-access", refreshToken: "cached-refresh" });
  });

  it("single-flights concurrent calls for the same stale account into one underlying refresh", async () => {
    let resolveRefresh: ((value: { accessToken: string; expiresAt: Date }) => void) | undefined;
    const refreshAccessToken = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresAt: Date }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const coordinator = coordinatorWith(refreshAccessToken);
    const stale = staleAccount();

    const first = coordinator.getValidAccessToken(stale);
    const second = coordinator.getValidAccessToken(stale);
    resolveRefresh?.({
      accessToken: "shared-access",
      expiresAt: new Date(NOW.getTime() + 3600_000),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(firstResult.accessToken).toBe("shared-access");
    expect(secondResult.accessToken).toBe("shared-access");
  });

  it("a failed refresh does not poison a later, independent attempt", async () => {
    const refreshAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({
        accessToken: "recovered-access",
        expiresAt: new Date(NOW.getTime() + 3600_000),
      });
    const coordinator = coordinatorWith(refreshAccessToken);
    const stale = staleAccount();

    await expect(coordinator.getValidAccessToken(stale)).rejects.toThrow(RefreshFailedError);
    const result = await coordinator.getValidAccessToken(stale);

    expect(result.accessToken).toBe("recovered-access");
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it("classifies a Google invalid_grant response as reason 'invalid_grant'", async () => {
    const refreshAccessToken = vi.fn().mockRejectedValue({
      response: { data: { error: "invalid_grant" } },
    });
    const coordinator = coordinatorWith(refreshAccessToken);

    await expect(coordinator.getValidAccessToken(staleAccount())).rejects.toMatchObject({
      reason: "invalid_grant",
    });
  });

  it("classifies a generic network failure as reason 'transient'", async () => {
    const refreshAccessToken = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const coordinator = coordinatorWith(refreshAccessToken);

    await expect(coordinator.getValidAccessToken(staleAccount())).rejects.toMatchObject({
      reason: "transient",
    });
  });

  it("classifies a corrupted stored envelope as reason 'invalid_grant'", async () => {
    const refreshAccessToken = vi.fn();
    const coordinator = coordinatorWith(refreshAccessToken);
    const corruptedAccount = account({
      expiresAt: new Date(NOW.getTime() + 60_000),
      tokenEnvelope: { v: 1, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" },
    });

    await expect(coordinator.getValidAccessToken(corruptedAccount)).rejects.toMatchObject({
      reason: "invalid_grant",
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("never lets the raw rejection — client secret and refresh token included — reach `cause`", async () => {
    const gaxiosLikeError = Object.assign(new Error("invalid_grant"), {
      config: {
        url: "https://oauth2.googleapis.com/token",
        data: "refresh_token=cached-refresh&client_id=id.apps.googleusercontent.com&client_secret=SUPER-SECRET&grant_type=refresh_token",
        headers: { authorization: "Basic SUPER-SECRET" },
      },
      response: {
        status: 400,
        data: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        config: { data: "client_secret=SUPER-SECRET" },
      },
    });
    const coordinator = coordinatorWith(vi.fn().mockRejectedValue(gaxiosLikeError));

    const failure = await coordinator.getValidAccessToken(staleAccount()).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RefreshFailedError);
    const { cause } = failure as RefreshFailedError;
    expect(cause).not.toBe(gaxiosLikeError);
    expect(cause).toEqual({
      message: "invalid_grant",
      status: 400,
      error: "invalid_grant",
      errorDescription: "Token has been expired or revoked.",
    } satisfies RefreshErrorDetail);

    const serialized = JSON.stringify(cause);
    expect(serialized).not.toContain("SUPER-SECRET");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("cached-refresh");
  });

  it("keeps a decrypt failure's cause to a safe extract too", async () => {
    const coordinator = coordinatorWith(vi.fn());
    const corruptedAccount = account({
      expiresAt: new Date(NOW.getTime() + 60_000),
      tokenEnvelope: { v: 1, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" },
    });

    const failure = await coordinator
      .getValidAccessToken(corruptedAccount)
      .catch((e: unknown) => e);

    const { cause } = failure as RefreshFailedError;
    expect(Object.keys(cause as object)).toEqual(["message"]);
  });
});
