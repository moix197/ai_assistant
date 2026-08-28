import type { Clock } from "@hermes/core";
import type { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAccount } from "../account-repo-port";
import { REFRESH_SKEW_MS, RefreshFailedError, createRefreshCoordinator } from "../refresh";
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

function fakeOAuthClient(refreshToken: OAuth2Client["refreshToken"]): OAuth2Client {
  return { refreshToken } as unknown as OAuth2Client;
}

describe("createRefreshCoordinator", () => {
  it("returns the cached token unchanged for a fresh account, calling oauthClient.refreshToken zero times", async () => {
    const refreshToken = vi.fn();
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const freshAccount = account({ expiresAt: new Date(NOW.getTime() + REFRESH_SKEW_MS + 60_000) });

    const result = await coordinator.getValidAccessToken(freshAccount);

    expect(result.accessToken).toBe("cached-access");
    expect(result.account).toBe(freshAccount);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("refreshes a stale account and reseals with a fresh IV", async () => {
    const refreshToken = vi.fn().mockResolvedValue({
      tokens: { access_token: "new-access", expiry_date: NOW.getTime() + 3600_000 },
    });
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const staleAccount = account({ expiresAt: new Date(NOW.getTime() + 60_000) });

    const result = await coordinator.getValidAccessToken(staleAccount);

    expect(result.accessToken).toBe("new-access");
    expect(refreshToken).toHaveBeenCalledWith("cached-refresh");
    expect(result.account.tokenEnvelope.iv).not.toBe(staleAccount.tokenEnvelope.iv);
    expect(result.account.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));
    expect(
      JSON.parse(openToken(result.account.tokenEnvelope, CRYPTO_KEY)) as {
        accessToken: string;
        refreshToken: string;
      },
    ).toEqual({ accessToken: "new-access", refreshToken: "cached-refresh" });
  });

  it("single-flights concurrent calls for the same stale account into one underlying refresh", async () => {
    type FakeRefreshResponse = {
      tokens: { access_token: string; expiry_date: number };
      res: null;
    };
    let resolveRefresh: ((value: FakeRefreshResponse) => void) | undefined;
    const refreshToken = vi.fn(
      () =>
        new Promise<FakeRefreshResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const staleAccount = account({ expiresAt: new Date(NOW.getTime() + 60_000) });

    const first = coordinator.getValidAccessToken(staleAccount);
    const second = coordinator.getValidAccessToken(staleAccount);
    resolveRefresh?.({
      tokens: { access_token: "shared-access", expiry_date: NOW.getTime() + 3600_000 },
      res: null,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(firstResult.accessToken).toBe("shared-access");
    expect(secondResult.accessToken).toBe("shared-access");
  });

  it("a failed refresh does not poison a later, independent attempt", async () => {
    const refreshToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({
        tokens: { access_token: "recovered-access", expiry_date: NOW.getTime() + 3600_000 },
      });
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const staleAccount = account({ expiresAt: new Date(NOW.getTime() + 60_000) });

    await expect(coordinator.getValidAccessToken(staleAccount)).rejects.toThrow(RefreshFailedError);
    const result = await coordinator.getValidAccessToken(staleAccount);

    expect(result.accessToken).toBe("recovered-access");
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("classifies a Google invalid_grant response as reason 'invalid_grant'", async () => {
    const refreshToken = vi.fn().mockRejectedValue({
      response: { data: { error: "invalid_grant" } },
    });
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const staleAccount = account({ expiresAt: new Date(NOW.getTime() + 60_000) });

    await expect(coordinator.getValidAccessToken(staleAccount)).rejects.toMatchObject({
      reason: "invalid_grant",
    });
  });

  it("classifies a generic network failure as reason 'transient'", async () => {
    const refreshToken = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const staleAccount = account({ expiresAt: new Date(NOW.getTime() + 60_000) });

    await expect(coordinator.getValidAccessToken(staleAccount)).rejects.toMatchObject({
      reason: "transient",
    });
  });

  it("classifies a corrupted stored envelope as reason 'invalid_grant'", async () => {
    const refreshToken = vi.fn();
    const oauthClient = fakeOAuthClient(refreshToken);
    const coordinator = createRefreshCoordinator({
      oauthClient,
      cryptoKey: CRYPTO_KEY,
      clock: fixedClock(),
    });
    const corruptedAccount = account({
      expiresAt: new Date(NOW.getTime() + 60_000),
      tokenEnvelope: { v: 1, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" },
    });

    await expect(coordinator.getValidAccessToken(corruptedAccount)).rejects.toMatchObject({
      reason: "invalid_grant",
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });
});
