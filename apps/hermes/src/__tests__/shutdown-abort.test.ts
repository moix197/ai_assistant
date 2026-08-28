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
    const sweep = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("sweep.stop");
      }),
    };

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      sweep,
      drainTimeoutMs: 1000,
    });

    expect(callOrder).toEqual([
      "controller.abort",
      "channel.stop",
      "telemetryRecorder.stop",
      "sweep.stop",
      "lock.release",
      "pool.end",
    ]);
    expect(controller.signal.aborted).toBe(true);
  });

  it("resolves the drain promptly once the abort fires, instead of always waiting out drainTimeoutMs (idle-bot regression)", async () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const controller = new AbortController();
    // Mirrors the real Telegram poller once its getUpdates call is wired to
    // the shared shutdown signal (see packages/channels/src/telegram's
    // client.ts/poller.ts): the drain settles as soon as the signal aborts,
    // rather than a timer that always burns the full window regardless of
    // when abort() fired.
    const channel = {
      stop: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            // `controller.abort()` (called by `shutdown()` itself, above this
            // call) fires the abort event before `channel.stop()` runs, so an
            // already-aborted check is required — an `addEventListener` alone
            // would never fire, mirroring why the real fetch-based client
            // needs the same check (see client.ts's composed signal).
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            controller.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
    };
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const logger = createMockLogger();
    const telemetryRecorder = { stop: vi.fn().mockResolvedValue(undefined) };
    const sweep = { stop: vi.fn().mockResolvedValue(undefined) };

    const startedAt = Date.now();
    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      sweep,
      // A large ceiling: this test's assertion is meaningless if the drain
      // just happens to still be racing a short timeout — it must resolve
      // because the abort woke it, well before this backstop would ever fire.
      drainTimeoutMs: 5_000,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
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
    const sweep = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("sweep.stop");
      }),
    };

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      sweep,
      drainTimeoutMs: 1000,
    });

    expect(callOrder).toEqual([
      "channel.stop",
      "telemetryRecorder.stop",
      "sweep.stop",
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
    const sweep = { stop: vi.fn().mockResolvedValue(undefined) };

    await shutdown({
      channel,
      lock,
      pool,
      logger,
      controller,
      telemetryRecorder,
      sweep,
      drainTimeoutMs: 1000,
      telemetryFlushTimeoutMs: 20,
    });

    expect(callOrder).toEqual(["lock.release", "pool.end"]);
  });
});

describe("shutdown — refresh sweep stop (Phase 4)", () => {
  it("gives up on a stuck sweep.stop() after sweepStopTimeoutMs and still runs lock.release()/pool.end()", async () => {
    const callOrder: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const controller = { abort: vi.fn() };
    const channel = { stop: vi.fn().mockResolvedValue(undefined) };
    const telemetryRecorder = { stop: vi.fn().mockResolvedValue(undefined) };
    // Never resolves — the shutdown-time sweep stop must not hang waiting on it.
    const sweep = { stop: vi.fn().mockImplementation(() => new Promise(() => {})) };
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
      sweep,
      drainTimeoutMs: 1000,
      sweepStopTimeoutMs: 20,
    });

    expect(callOrder).toEqual(["lock.release", "pool.end"]);
  });
});
