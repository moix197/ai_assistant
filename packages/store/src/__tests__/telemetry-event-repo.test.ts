import type { TelemetryEvent } from "@hermes/core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { insertEvents } from "../telemetry-event-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("telemetry-event-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves the
    // migration itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM telemetry_events");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("writes a mixed batch in one round trip, with fixed columns populated correctly per event kind", async () => {
    const events: TelemetryEvent[] = [
      {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 70,
        outputTokens: 20,
        cacheHitTokens: 30,
        durationMs: 850,
        costUsd: 0.000123,
      },
      {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        durationMs: 12,
        costUsd: 0,
        error: "LLM provider returned HTTP 500",
      },
      {
        name: "tool.call",
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "search",
        durationMs: 300,
        approved: true,
      },
      {
        name: "turn",
        threadId: "thread-1",
        turnId: "turn-1",
        iterations: 3,
        totalCostUsd: 0.0005,
        outcome: "completed",
        durationMs: 4000,
      },
    ];

    const querySpy = vi.spyOn(pool, "query");

    await insertEvents(pool, events);

    // Proves one multi-row INSERT, never a loop of single-row inserts.
    expect(querySpy).toHaveBeenCalledTimes(1);

    const result = await pool.query<{
      name: string;
      thread_id: string | null;
      turn_id: string | null;
      tool_name: string | null;
      duration_ms: number | null;
      cost_usd: string | null;
      is_error: boolean;
      fields: Record<string, unknown>;
    }>("SELECT * FROM telemetry_events ORDER BY id ASC");

    expect(result.rows).toHaveLength(4);

    const [success, failure, toolCall, turn] = result.rows;

    expect(success?.name).toBe("llm.call");
    expect(success?.is_error).toBe(false);
    expect(success?.tool_name).toBeNull();
    expect(Number(success?.cost_usd)).toBeCloseTo(0.000123, 6);
    expect(success?.fields).toMatchObject({
      model: "deepseek-v4-flash",
      inputTokens: 70,
      outputTokens: 20,
      cacheHitTokens: 30,
    });
    expect(success?.fields.error).toBeUndefined();

    expect(failure?.name).toBe("llm.call");
    expect(failure?.is_error).toBe(true);
    expect(failure?.fields).toMatchObject({ error: "LLM provider returned HTTP 500" });

    expect(toolCall?.name).toBe("tool.call");
    expect(toolCall?.thread_id).toBe("thread-1");
    expect(toolCall?.turn_id).toBe("turn-1");
    expect(toolCall?.tool_name).toBe("search");
    expect(toolCall?.cost_usd).toBeNull();
    expect(toolCall?.is_error).toBe(false);
    expect(toolCall?.fields).toMatchObject({ approved: true });

    expect(turn?.name).toBe("turn");
    expect(turn?.tool_name).toBeNull();
    expect(Number(turn?.cost_usd)).toBeCloseTo(0.0005, 6);
    expect(turn?.is_error).toBe(false);
    expect(turn?.fields).toMatchObject({ iterations: 3, outcome: "completed" });
  });

  it("performs no query for an empty array", async () => {
    const querySpy = vi.spyOn(pool, "query");

    await insertEvents(pool, []);

    expect(querySpy).not.toHaveBeenCalled();

    const result = await pool.query("SELECT COUNT(*) AS count FROM telemetry_events");
    expect(result.rows[0]?.count).toBe("0");
  });
});
