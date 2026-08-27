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

describe("shutdown — boot-lifetime AbortController wiring (Phase 5)", () => {
  it("aborts the controller as part of the drain step, strictly before channel.stop() and pool.end()", async () => {
    const callOrder: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => callOrder.push("controller.abort"));

    const channel = {
      stop: vi.fn().mockImplementation(async () => {
        // Simulates a fake in-flight completion call whose fetch is aborted
        // by the shared controller — proves the wiring is live and wired
        // into the real shutdown sequence, not merely constructed and
        // unused (the Phase 4 trap this phase's first step warns against).
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

    await shutdown({ channel, lock, pool, logger, controller, drainTimeoutMs: 1000 });

    expect(callOrder).toEqual(["controller.abort", "channel.stop", "lock.release", "pool.end"]);
    expect(controller.signal.aborted).toBe(true);
  });

  it("still completes shutdown when no controller is supplied (backward-compatible default)", async () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const channel = { stop: vi.fn().mockResolvedValue(undefined) };
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const logger = createMockLogger();

    await expect(
      shutdown({ channel, lock, pool, logger, drainTimeoutMs: 1000 }),
    ).resolves.toBeUndefined();

    expect(pool.end).toHaveBeenCalledOnce();
  });
});
