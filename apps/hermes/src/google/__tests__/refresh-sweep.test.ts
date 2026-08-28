import type { Clock, Logger } from "@hermes/core";
import {
  type GetValidAccessTokenResult,
  type GoogleAccount,
  REFRESH_SKEW_MS,
  type RefreshCoordinator,
  RefreshFailedError,
} from "@hermes/google-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_SWEEP_INTERVAL_MS,
  type RefreshSweepRepo,
  createRefreshSweep,
} from "../refresh-sweep";

const NOW = new Date("2026-08-28T00:00:00.000Z");

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fixedClock(now: Date = NOW): Clock {
  return { now: () => now };
}

function account(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "user-1",
    chatId: "chat-1",
    googleEmail: "person@example.com",
    scopes: ["openid"],
    tokenEnvelope: { v: 1, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" },
    expiresAt: NOW,
    ...overrides,
  };
}

function fakeRepo(accounts: GoogleAccount[]): RefreshSweepRepo & {
  upsertAccount: ReturnType<typeof vi.fn>;
  markDisconnected: ReturnType<typeof vi.fn>;
} {
  return {
    listAccountsExpiringBefore: vi.fn().mockResolvedValue(accounts),
    upsertAccount: vi.fn().mockResolvedValue(undefined),
    markDisconnected: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeCoordinator(
  getValidAccessToken: (account: GoogleAccount) => Promise<GetValidAccessTokenResult>,
): RefreshCoordinator {
  return { getValidAccessToken: vi.fn(getValidAccessToken) };
}

function fakeChannel(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ messageId: "1" }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRefreshSweep.runOnce", () => {
  it("calls coordinator.getValidAccessToken for every account listAccountsExpiringBefore returns, using the cutoff derived from REFRESH_SKEW_MS", async () => {
    const stale = account();
    const repo = fakeRepo([stale]);
    const coordinator = fakeCoordinator(async (a) => ({ accessToken: "tok", account: a }));
    const channel = fakeChannel();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel,
      clock: fixedClock(),
      logger: createMockLogger(),
    });

    await sweep.runOnce();

    expect(repo.listAccountsExpiringBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() + REFRESH_SKEW_MS),
    );
    expect(coordinator.getValidAccessToken).toHaveBeenCalledWith(stale);
  });

  it("persists a successful refresh via repo.upsertAccount", async () => {
    const stale = account();
    const refreshed = { ...stale, expiresAt: new Date(NOW.getTime() + 3600_000) };
    const repo = fakeRepo([stale]);
    const coordinator = fakeCoordinator(async () => ({ accessToken: "tok", account: refreshed }));
    const channel = fakeChannel();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel,
      clock: fixedClock(),
      logger: createMockLogger(),
    });

    await sweep.runOnce();

    expect(repo.upsertAccount).toHaveBeenCalledWith(refreshed);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("on an invalid_grant failure, marks the account disconnected and sends a reconnect alert to chatId", async () => {
    const stale = account({ chatId: "chat-42" });
    const repo = fakeRepo([stale]);
    const coordinator = fakeCoordinator(async () => {
      throw new RefreshFailedError("invalid_grant", "revoked");
    });
    const channel = fakeChannel();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel,
      clock: fixedClock(),
      logger: createMockLogger(),
    });

    await sweep.runOnce();

    expect(repo.markDisconnected).toHaveBeenCalledWith("telegram", "user-1");
    expect(channel.send).toHaveBeenCalledWith("chat-42", expect.stringContaining("reconnect"));
    expect(repo.upsertAccount).not.toHaveBeenCalled();
  });

  it("on a transient failure, touches neither markDisconnected nor upsertAccount nor sends an alert", async () => {
    const stale = account();
    const repo = fakeRepo([stale]);
    const coordinator = fakeCoordinator(async () => {
      throw new RefreshFailedError("transient", "network blip");
    });
    const channel = fakeChannel();
    const logger = createMockLogger();
    const sweep = createRefreshSweep({ repo, coordinator, channel, clock: fixedClock(), logger });

    await sweep.runOnce();

    expect(repo.markDisconnected).not.toHaveBeenCalled();
    expect(repo.upsertAccount).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("zero expiring accounts is a no-op, not an error", async () => {
    const repo = fakeRepo([]);
    const coordinator = fakeCoordinator(async (a) => ({ accessToken: "tok", account: a }));
    const channel = fakeChannel();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel,
      clock: fixedClock(),
      logger: createMockLogger(),
    });

    await expect(sweep.runOnce()).resolves.toBeUndefined();
    expect(coordinator.getValidAccessToken).not.toHaveBeenCalled();
  });
});

describe("createRefreshSweep.start/stop", () => {
  it("runs runOnce immediately, then again on each interval, and stops cleanly on an aborted signal", async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo([]);
      const coordinator = fakeCoordinator(async (a) => ({ accessToken: "tok", account: a }));
      const channel = fakeChannel();
      const sweep = createRefreshSweep({
        repo,
        coordinator,
        channel,
        clock: fixedClock(),
        logger: createMockLogger(),
      });
      const controller = new AbortController();

      sweep.start(REFRESH_SWEEP_INTERVAL_MS, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.listAccountsExpiringBefore).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(REFRESH_SWEEP_INTERVAL_MS);
      expect(repo.listAccountsExpiringBefore).toHaveBeenCalledTimes(2);

      controller.abort();
      await vi.advanceTimersByTimeAsync(REFRESH_SWEEP_INTERVAL_MS * 2);
      expect(repo.listAccountsExpiringBefore).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() awaits the in-flight runOnce() call", async () => {
    let resolveList: ((accounts: GoogleAccount[]) => void) | undefined;
    const repo: RefreshSweepRepo = {
      listAccountsExpiringBefore: vi.fn(
        () =>
          new Promise<GoogleAccount[]>((resolve) => {
            resolveList = resolve;
          }),
      ),
      upsertAccount: vi.fn().mockResolvedValue(undefined),
      markDisconnected: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = fakeCoordinator(async (a) => ({ accessToken: "tok", account: a }));
    const channel = fakeChannel();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel,
      clock: fixedClock(),
      logger: createMockLogger(),
    });
    const controller = new AbortController();

    sweep.start(REFRESH_SWEEP_INTERVAL_MS, controller.signal);
    let stopped = false;
    const stopPromise = sweep.stop().then(() => {
      stopped = true;
    });

    expect(stopped).toBe(false);
    resolveList?.([]);
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
