import { getDefaultMigrationsDir, insertEvents, runMigrations } from "@hermes/store";
// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "@hermes/store/testing";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryEventRepo } from "../event-repo-port";
import { createBufferedTelemetryRecorder } from "../recorder";

// The phase's headline proof: a real recorder wired to @hermes/store's real
// insertEvents, end to end against a real Postgres. This is thin in-test
// wiring only — apps/hermes/src/telemetry/build-telemetry-recorder.ts
// (Phase 2) is the production wiring site; nothing here should be mistaken
// for it.
describe.skipIf(!testDatabaseUrl)("createBufferedTelemetryRecorder (integration)", () => {
  let pool: Pool;
  let repo: TelemetryEventRepo;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM telemetry_events");
    repo = { insertEvents: (events) => insertEvents(pool, events) };
  });

  afterEach(async () => {
    await pool.end();
  });

  it("round-trips a hand-fed llm.call event into a real telemetry_events row on stop()", async () => {
    const recorder = createBufferedTelemetryRecorder(repo, {
      // Large enough that neither trigger fires before the explicit stop()
      // below — this test proves the drain-on-stop path, not the timer or
      // threshold paths (covered by recorder.test.ts).
      flushThreshold: 1_000,
      flushIntervalMs: 999_999,
    });

    recorder.record({
      name: "llm.call",
      threadId: null,
      turnId: null,
      model: "deepseek-v4-flash",
      inputTokens: 70,
      outputTokens: 20,
      cacheHitTokens: 30,
      durationMs: 850,
      costUsd: 0.000123,
    });

    await recorder.stop();

    const result = await pool.query<{
      name: string;
      thread_id: string | null;
      turn_id: string | null;
      duration_ms: number;
      cost_usd: string;
      is_error: boolean;
      fields: Record<string, unknown>;
    }>("SELECT * FROM telemetry_events");

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.name).toBe("llm.call");
    expect(row?.thread_id).toBeNull();
    expect(row?.turn_id).toBeNull();
    expect(row?.duration_ms).toBe(850);
    expect(Number(row?.cost_usd)).toBeCloseTo(0.000123, 6);
    expect(row?.is_error).toBe(false);
    expect(row?.fields).toMatchObject({
      model: "deepseek-v4-flash",
      inputTokens: 70,
      outputTokens: 20,
      cacheHitTokens: 30,
    });
  });
});
