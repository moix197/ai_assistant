import type { Logger } from "@hermes/core";
import type { GoogleAccount, GoogleAccountRepo, RefreshCoordinator } from "@hermes/google-auth";
import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { buildRefreshSweep, buildSheetsDeps } from "../boot";

/**
 * Code-review fix (Phase 4): `boot.ts` used to construct a SECOND
 * `RefreshCoordinator` inside `buildSheetsDeps`, independent of the one
 * `buildRefreshSweep` built — two separate single-flight maps
 * (`packages/google-auth/src/refresh.ts`) for the same accounts, letting
 * the sweep and a Sheets tool call refresh concurrently and both write
 * tokens (contradicting settled decision 18). The fix is `wireRuntimeAndShutdown`
 * building exactly one coordinator and injecting it into both. These tests
 * prove the injection side of that fix directly: neither `buildSheetsDeps`
 * nor `buildRefreshSweep` builds its own coordinator internally — each
 * routes every refresh through the exact instance it was given. Combined
 * with `wireRuntimeAndShutdown` calling the coordinator builder exactly
 * once (see `boot.ts`), this is what makes the two paths share one
 * instance.
 */

function fakeAccount(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: ["openid"],
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    channel: "telegram",
    channel_user_id: "111",
    chat_id: "555",
    google_email: "person@example.com",
    scopes: ["openid"],
    token_envelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expires_at: new Date("2020-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakePool(rows: unknown[] = []): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe("buildSheetsDeps / buildRefreshSweep — shared RefreshCoordinator", () => {
  it("buildSheetsDeps' AccessTokenPort routes every call through the exact injected coordinator", async () => {
    const account = fakeAccount();
    const getValidAccessToken = vi
      .fn()
      .mockResolvedValue({ accessToken: "tok-from-injected-coordinator", account });
    const coordinator: RefreshCoordinator = { getValidAccessToken };
    const googleAccountRepo: GoogleAccountRepo = {
      getAccount: vi.fn().mockResolvedValue(account),
      upsertAccount: vi.fn(),
      deleteAccount: vi.fn(),
    };

    const deps = buildSheetsDeps(fakePool(), googleAccountRepo, coordinator);
    const token = await deps.accessTokenPort.getAccessToken("telegram", "111");

    expect(token).toBe("tok-from-injected-coordinator");
    expect(getValidAccessToken).toHaveBeenCalledTimes(1);
    expect(getValidAccessToken).toHaveBeenCalledWith(account);
  });

  it("buildRefreshSweep's runOnce routes every account through the exact injected coordinator", async () => {
    const pool = fakePool([fakeAccountRow()]);
    const getValidAccessToken = vi.fn().mockImplementation(async (account: GoogleAccount) => ({
      accessToken: "tok-from-injected-coordinator",
      account,
    }));
    const coordinator: RefreshCoordinator = { getValidAccessToken };
    const channel = { send: vi.fn() };

    const sweep = buildRefreshSweep(pool, channel, fakeLogger(), coordinator);
    expect(sweep).toBeDefined();
    await sweep?.runOnce();

    expect(getValidAccessToken).toHaveBeenCalledTimes(1);
  });

  it("both builders return undefined/the throwing stub when no coordinator is injected — neither falls back to building its own", async () => {
    const pool = fakePool([fakeAccountRow()]);
    expect(buildRefreshSweep(pool, { send: vi.fn() }, fakeLogger(), undefined)).toBeUndefined();

    const googleAccountRepo: GoogleAccountRepo = {
      getAccount: vi.fn(),
      upsertAccount: vi.fn(),
      deleteAccount: vi.fn(),
    };
    const deps = buildSheetsDeps(pool, googleAccountRepo, undefined);
    await expect(deps.accessTokenPort.getAccessToken("telegram", "111")).rejects.toThrow(
      /not configured/,
    );
  });
});
