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
  updateRefreshedTokens: ReturnType<typeof vi.fn>;
  markDisconnected: ReturnType<typeof vi.fn>;
} {
  return {
    listAccountsExpiringBefore: vi.fn().mockResolvedValue(accounts),
    updateRefreshedTokens: vi.fn().mockResolvedValue(undefined),
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

  it("persists a successful refresh via repo.updateRefreshedTokens", async () => {
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

    expect(repo.updateRefreshedTokens).toHaveBeenCalledWith(refreshed);
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
    expect(repo.updateRefreshedTokens).not.toHaveBeenCalled();
  });

  it("on a transient failure, touches neither markDisconnected nor updateRefreshedTokens nor sends an alert", async () => {
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
    expect(repo.updateRefreshedTokens).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("logs the terminal disconnect, with channel/channelUserId/reason, before mutating", async () => {
    const stale = account();
    const repo = fakeRepo([stale]);
    const coordinator = fakeCoordinator(async () => {
      throw new RefreshFailedError("invalid_grant", "revoked");
    });
    const logger = createMockLogger();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel: fakeChannel(),
      clock: fixedClock(),
      logger,
    });

    await sweep.runOnce();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("disconnecting"),
      expect.objectContaining({
        channel: "telegram",
        channelUserId: "user-1",
        reason: "invalid_grant",
      }),
    );
  });

  it("a failing reconnect alert neither hides the completed disconnect nor skips the accounts after it", async () => {
    const repo = fakeRepo([
      account({ channelUserId: "blocked" }),
      account({ channelUserId: "ok" }),
    ]);
    const coordinator = fakeCoordinator(async (a) => {
      if (a.channelUserId === "blocked") throw new RefreshFailedError("invalid_grant", "revoked");
      return { accessToken: "tok", account: a };
    });
    const channel = fakeChannel();
    channel.send.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    const logger = createMockLogger();
    const sweep = createRefreshSweep({ repo, coordinator, channel, clock: fixedClock(), logger });

    await sweep.runOnce();

    expect(repo.markDisconnected).toHaveBeenCalledWith("telegram", "blocked");
    expect(repo.updateRefreshedTokens).toHaveBeenCalledWith(
      expect.objectContaining({ channelUserId: "ok" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reconnect alert"),
      expect.objectContaining({ channelUserId: "blocked" }),
    );
  });

  it("a throwing failure handler is logged and does not skip the accounts after it", async () => {
    const repo = fakeRepo([account({ channelUserId: "broken" }), account({ channelUserId: "ok" })]);
    repo.markDisconnected.mockRejectedValue(new Error("connection terminated"));
    const coordinator = fakeCoordinator(async (a) => {
      if (a.channelUserId === "broken") throw new RefreshFailedError("invalid_grant", "revoked");
      return { accessToken: "tok", account: a };
    });
    const logger = createMockLogger();
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel: fakeChannel(),
      clock: fixedClock(),
      logger,
    });

    await expect(sweep.runOnce()).resolves.toBeUndefined();

    expect(repo.updateRefreshedTokens).toHaveBeenCalledWith(
      expect.objectContaining({ channelUserId: "ok" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("handling a refresh failure"),
      expect.objectContaining({ channelUserId: "broken" }),
    );
  });

  it("a /disconnect landing during an in-flight refresh is not undone by the sweep's write", async () => {
    const stale = account();
    const rows = new Map<string, GoogleAccount>([[stale.channelUserId, stale]]);
    const repo: RefreshSweepRepo = {
      listAccountsExpiringBefore: async () => [...rows.values()],
      // UPDATE-only, like the real repo: a row the user disconnected mid-refresh
      // stays gone rather than being re-created from the sweep's stale snapshot.
      updateRefreshedTokens: async (updated) => {
        const existing = rows.get(updated.channelUserId);
        if (existing) rows.set(updated.channelUserId, { ...existing, ...updated });
      },
      markDisconnected: async (_channel, channelUserId) => {
        rows.delete(channelUserId);
      },
    };
    const coordinator = fakeCoordinator(async (a) => {
      rows.delete(a.channelUserId);
      return {
        accessToken: "tok",
        account: { ...a, expiresAt: new Date(NOW.getTime() + 3600_000) },
      };
    });
    const sweep = createRefreshSweep({
      repo,
      coordinator,
      channel: fakeChannel(),
      clock: fixedClock(),
      logger: createMockLogger(),
    });

    await sweep.runOnce();

    expect(rows.size).toBe(0);
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

  it("skips and logs a tick that fires while the previous one is still running", async () => {
    vi.useFakeTimers();
    try {
      let resolveList: ((accounts: GoogleAccount[]) => void) | undefined;
      const repo: RefreshSweepRepo = {
        listAccountsExpiringBefore: vi.fn(
          () =>
            new Promise<GoogleAccount[]>((resolve) => {
              resolveList = resolve;
            }),
        ),
        updateRefreshedTokens: vi.fn().mockResolvedValue(undefined),
        markDisconnected: vi.fn().mockResolvedValue(undefined),
      };
      const logger = createMockLogger();
      const sweep = createRefreshSweep({
        repo,
        coordinator: fakeCoordinator(async (a) => ({ accessToken: "tok", account: a })),
        channel: fakeChannel(),
        clock: fixedClock(),
        logger,
      });
      const controller = new AbortController();

      sweep.start(REFRESH_SWEEP_INTERVAL_MS, controller.signal);
      await vi.advanceTimersByTimeAsync(REFRESH_SWEEP_INTERVAL_MS * 2);

      expect(repo.listAccountsExpiringBefore).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("skipping"));

      // The skipped ticks must not have replaced what stop() awaits.
      let stopped = false;
      const stopPromise = sweep.stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      resolveList?.([]);
      await stopPromise;
      expect(stopped).toBe(true);
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
      updateRefreshedTokens: vi.fn().mockResolvedValue(undefined),
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
