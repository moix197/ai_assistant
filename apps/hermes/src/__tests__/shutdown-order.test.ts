import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShutdown, shutdown } from "../boot";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shutdown", () => {
  it("stops the channel, releases the lock, ends the pool, then exits — in that exact order", async () => {
    const callOrder: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const channel = {
      stop: vi.fn().mockImplementation(async () => {
        // Simulates the in-flight handler still resolving.
        await new Promise((resolve) => setTimeout(resolve, 5));
        callOrder.push("channel.stop");
      }),
    };
    const lock = {
      release: vi.fn().mockImplementation(async () => {
        callOrder.push("lock.release");
      }),
    };
    const pool = {
      end: vi.fn().mockImplementation(async () => {
        callOrder.push("pool.end");
      }),
    };
    const logger = createMockLogger();

    await shutdown({ channel, lock, pool, logger, drainTimeoutMs: 1000 });
    callOrder.push("process.exit");

    expect(callOrder).toEqual(["channel.stop", "lock.release", "pool.end", "process.exit"]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("gives up waiting on a stuck channel.stop() after drainTimeoutMs and still releases the lock", async () => {
    const callOrder: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const channel = { stop: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const lock = {
      release: vi.fn().mockImplementation(async () => {
        callOrder.push("lock.release");
      }),
    };
    const pool = {
      end: vi.fn().mockImplementation(async () => {
        callOrder.push("pool.end");
      }),
    };
    const logger = createMockLogger();

    await shutdown({ channel, lock, pool, logger, drainTimeoutMs: 20 });

    expect(callOrder).toEqual(["lock.release", "pool.end"]);
  });
});

describe("registerShutdown", () => {
  it("still forces a non-zero exit when a shutdown step throws, without clearing the hard-exit guard early", async () => {
    vi.useFakeTimers();
    try {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const channel = { stop: vi.fn().mockResolvedValue(undefined) };
      const lock = { release: vi.fn().mockRejectedValue(new Error("DB down")) };
      const pool = { end: vi.fn().mockResolvedValue(undefined) };
      const logger = createMockLogger();

      registerShutdown({ channel, lock, pool, logger, drainTimeoutMs: 10 });
      process.emit("SIGTERM");

      await vi.runAllTimersAsync();

      // The failed shutdown itself forces exit(1) — not the hard-exit
      // fallback timer, which must remain armed (never cleared) on this path.
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(pool.end).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "shutdown failed, forcing exit",
        expect.objectContaining({ error: expect.stringContaining("DB down") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
