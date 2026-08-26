import type { Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdown } from "../boot";

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
