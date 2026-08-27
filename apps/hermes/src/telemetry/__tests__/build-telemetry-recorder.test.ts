import type { Logger, TelemetryEvent } from "@hermes/core";
import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { buildTelemetryRecorder } from "../build-telemetry-recorder";

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A pool whose `query` is never expected to run directly in this pure wiring test. */
function createMockPool(): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

const EVENT: TelemetryEvent = {
  name: "llm.call",
  threadId: null,
  turnId: null,
  model: "deepseek-v4-flash",
  inputTokens: 10,
  outputTokens: 5,
  cacheHitTokens: 0,
  durationMs: 42,
  costUsd: 0.001,
};

describe("buildTelemetryRecorder — boot wiring", () => {
  it("returns a handle whose record()/stop() delegate to @hermes/store's insertEvents against the real pool", async () => {
    const pool = createMockPool();
    const recorder = buildTelemetryRecorder(pool, createMockLogger());

    recorder.record(EVENT);
    await recorder.stop();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO telemetry_events"),
      expect.arrayContaining(["llm.call"]),
    );
  });

  it("wires the app's real logger through, not the recorder's no-op default", async () => {
    const pool = createMockPool();
    const logger = createMockLogger();
    const recorder = buildTelemetryRecorder(pool, logger);

    // Overflow a buffer of maxBufferSize 1 by constructing directly isn't
    // possible through this wiring seam (defaults are fixed), so this test
    // instead proves the logger reaches a real failure path: a rejected
    // flush must be reported through the injected logger, not swallowed.
    pool.query.mockRejectedValueOnce(new Error("db down"));
    recorder.record(EVENT);
    await recorder.stop();

    expect(logger.error).toHaveBeenCalledWith(
      "telemetry flush failed, batch discarded",
      expect.objectContaining({ error: "db down" }),
    );
  });
});
