import type {
  GetValidAccessTokenResult,
  GoogleAccount,
  GoogleAccountRepo,
} from "@hermes/google-auth";
import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { buildAccessTokenPort } from "../build-access-token-port";

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function mockPool(): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

function fakeGoogleAccountRepo(account: GoogleAccount | undefined): GoogleAccountRepo {
  return {
    getAccount: vi.fn().mockResolvedValue(account),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn(),
  };
}

describe("buildAccessTokenPort", () => {
  it("throws when no account is connected, without calling the refresh coordinator", async () => {
    const pool = mockPool();
    const googleAccountRepo = fakeGoogleAccountRepo(undefined);
    const getValidAccessToken = vi.fn();
    const port = buildAccessTokenPort({
      pool,
      googleAccountRepo,
      refreshCoordinator: { getValidAccessToken },
    });

    await expect(port.getAccessToken("telegram", "111")).rejects.toThrow(
      /no Google account connected/,
    );
    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns the token and persists nothing when the account was fresh (coordinator returned the same account object)", async () => {
    const pool = mockPool();
    const account = fakeAccount();
    const googleAccountRepo = fakeGoogleAccountRepo(account);
    const result: GetValidAccessTokenResult = { accessToken: "cached-token", account };
    const port = buildAccessTokenPort({
      pool,
      googleAccountRepo,
      refreshCoordinator: { getValidAccessToken: vi.fn().mockResolvedValue(result) },
    });

    const token = await port.getAccessToken("telegram", "111");

    expect(token).toBe("cached-token");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("persists a refreshed account via the UPDATE-only updateRefreshedTokens, never upsertAccount's INSERT/ON CONFLICT — the resurrection guard", async () => {
    const pool = mockPool();
    const account = fakeAccount();
    const refreshedAccount: GoogleAccount = {
      ...account,
      tokenEnvelope: { v: 1, iv: "iv2", tag: "tag2", ct: "ct2" },
      expiresAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    const googleAccountRepo = fakeGoogleAccountRepo(account);
    const result: GetValidAccessTokenResult = {
      accessToken: "refreshed-token",
      account: refreshedAccount,
    };
    const port = buildAccessTokenPort({
      pool,
      googleAccountRepo,
      refreshCoordinator: { getValidAccessToken: vi.fn().mockResolvedValue(result) },
    });

    const token = await port.getAccessToken("telegram", "111");

    expect(token).toBe("refreshed-token");
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE google_accounts");
    expect(sql).not.toContain("INSERT INTO google_accounts");
    expect(sql).not.toContain("ON CONFLICT");
  });
});
