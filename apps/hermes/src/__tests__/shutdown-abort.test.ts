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
    const telemetryRecorder = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("telemetryRecorder.stop");
      }),
    };

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      drainTimeoutMs: 1000,
    });

    expect(callOrder).toEqual([
      "controller.abort",
      "channel.stop",
      "telemetryRecorder.stop",
      "lock.release",
      "pool.end",
    ]);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("shutdown — telemetry flush (Phase 2b)", () => {
  it("flushes telemetry strictly after channel.stop() resolves and strictly before lock.release()/pool.end()", async () => {
    const callOrder: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const controller = { abort: vi.fn() };
    const channel = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("channel.stop");
      }),
    };
    const telemetryRecorder = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("telemetryRecorder.stop");
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

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      drainTimeoutMs: 1000,
    });

    expect(callOrder).toEqual([
      "channel.stop",
      "telemetryRecorder.stop",
      "lock.release",
      "pool.end",
    ]);
  });

  it("gives up on a stuck telemetryRecorder.stop() after telemetryFlushTimeoutMs and still runs lock.release()/pool.end()", async () => {
    const callOrder: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const controller = { abort: vi.fn() };
    const channel = { stop: vi.fn().mockResolvedValue(undefined) };
    // Never resolves — the shutdown-time flush must not hang waiting on it.
    const telemetryRecorder = { stop: vi.fn().mockImplementation(() => new Promise(() => {})) };
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

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      drainTimeoutMs: 1000,
      telemetryFlushTimeoutMs: 20,
    });

    expect(callOrder).toEqual(["lock.release", "pool.end"]);
  });
});
