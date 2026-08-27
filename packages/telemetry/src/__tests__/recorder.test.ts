import type { LlmCallEvent, Logger } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEventRepo } from "../event-repo-port";
import { createBufferedTelemetryRecorder } from "../recorder";

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockRepo(): TelemetryEventRepo & { insertEvents: ReturnType<typeof vi.fn> } {
  return { insertEvents: vi.fn().mockResolvedValue(undefined) };
}

function llmCallEvent(overrides: Partial<LlmCallEvent> = {}): LlmCallEvent {
  return {
    name: "llm.call",
    threadId: null,
    turnId: null,
    model: "deepseek-v4-flash",
    inputTokens: 10,
    outputTokens: 5,
    cacheHitTokens: 0,
    durationMs: 42,
    costUsd: 0.0001,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createBufferedTelemetryRecorder", () => {
  it("record() returns synchronously without awaiting the repo", () => {
    // insertEvents never resolves — if record() awaited it, this call would hang the test.
    const repo: TelemetryEventRepo = { insertEvents: vi.fn(() => new Promise<void>(() => {})) };
    const recorder = createBufferedTelemetryRecorder(repo, {
      flushThreshold: 1,
      flushIntervalMs: 999_999,
    });

    const result = recorder.record(llmCallEvent());

    expect(result).toBeUndefined();
    expect(repo.insertEvents).toHaveBeenCalledTimes(1);
  });

  it("flushes automatically once the buffer reaches flushThreshold, calling insertEvents with the batched events", () => {
    const repo = createMockRepo();
    const recorder = createBufferedTelemetryRecorder(repo, {
      flushThreshold: 3,
      flushIntervalMs: 999_999,
    });
    const events = [
      llmCallEvent({ model: "a" }),
      llmCallEvent({ model: "b" }),
      llmCallEvent({ model: "c" }),
    ];

    for (const event of events) recorder.record(event);

    expect(repo.insertEvents).toHaveBeenCalledTimes(1);
    expect(repo.insertEvents).toHaveBeenCalledWith(events);
  });

  it("flushes on a timer independently of flushThreshold", () => {
    vi.useFakeTimers();
    try {
      const repo = createMockRepo();
      const recorder = createBufferedTelemetryRecorder(repo, {
        flushThreshold: 50,
        flushIntervalMs: 1_000,
      });
      const event = llmCallEvent();
      recorder.record(event);
      expect(repo.insertEvents).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);

      expect(repo.insertEvents).toHaveBeenCalledTimes(1);
      expect(repo.insertEvents).toHaveBeenCalledWith([event]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never exceeds maxBufferSize under a burst larger than the bound, dropping the newest event and warning", async () => {
    const repo = createMockRepo();
    const logger = createMockLogger();
    const recorder = createBufferedTelemetryRecorder(repo, {
      flushThreshold: 1_000,
      flushIntervalMs: 999_999,
      maxBufferSize: 3,
      logger,
    });
    const events = Array.from({ length: 5 }, (_, i) => llmCallEvent({ model: `m${i}` }));

    for (const event of events) recorder.record(event);

    // Only the first 3 fit; the 4th and 5th are dropped, each warned once.
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "buffer full" }),
    );

    await recorder.stop();
    expect(repo.insertEvents).toHaveBeenCalledWith(events.slice(0, 3));
  });

  it("logs an error and discards the batch when insertEvents rejects, without wedging later flushes", async () => {
    const logger = createMockLogger();
    const repo: TelemetryEventRepo & { insertEvents: ReturnType<typeof vi.fn> } = {
      insertEvents: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(undefined),
    };
    const recorder = createBufferedTelemetryRecorder(repo, {
      flushThreshold: 1,
      flushIntervalMs: 999_999,
      logger,
    });

    const firstEvent = llmCallEvent({ model: "first" });
    recorder.record(firstEvent);
    // Let the rejected flush's catch handler run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ count: 1, error: "db down" }),
    );
    expect(repo.insertEvents).toHaveBeenNthCalledWith(1, [firstEvent]);

    const secondEvent = llmCallEvent({ model: "second" });
    recorder.record(secondEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The second flush only ever sees the second event — the first batch's
    // loss is permanent, not requeued alongside it.
    expect(repo.insertEvents).toHaveBeenCalledTimes(2);
    expect(repo.insertEvents).toHaveBeenNthCalledWith(2, [secondEvent]);
  });

  it("drops record() calls made after stop() has resolved, without throwing", async () => {
    const logger = createMockLogger();
    const repo = createMockRepo();
    const recorder = createBufferedTelemetryRecorder(repo, {
      flushThreshold: 1_000,
      flushIntervalMs: 999_999,
      logger,
    });

    recorder.record(llmCallEvent({ model: "before-stop" }));
    await recorder.stop();
    expect(repo.insertEvents).toHaveBeenCalledTimes(1);

    expect(() => recorder.record(llmCallEvent({ model: "after-stop" }))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "recorder stopped" }),
    );
    // The dropped post-stop event never reaches insertEvents.
    expect(repo.insertEvents).toHaveBeenCalledTimes(1);
  });

  it("stop() drains whatever remains in one final flush and stops the interval", async () => {
    vi.useFakeTimers();
    try {
      const repo = createMockRepo();
      const recorder = createBufferedTelemetryRecorder(repo, {
        flushThreshold: 1_000,
        flushIntervalMs: 1_000,
      });
      const event = llmCallEvent();
      recorder.record(event);
      expect(repo.insertEvents).not.toHaveBeenCalled();

      await recorder.stop();

      expect(repo.insertEvents).toHaveBeenCalledTimes(1);
      expect(repo.insertEvents).toHaveBeenCalledWith([event]);

      vi.advanceTimersByTime(5_000);
      expect(repo.insertEvents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
