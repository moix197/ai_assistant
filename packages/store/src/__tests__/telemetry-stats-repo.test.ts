import type { TelemetryEvent } from "@hermes/core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { insertEvents } from "../telemetry-event-repo";
import { getLlmCallStatsSince, getTopToolsSince } from "../telemetry-stats-repo";
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("telemetry-stats-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM telemetry_events");
  });

  afterEach(async () => {
    await pool.end();
  });

  async function insertEventAt(createdAtIso: string, event: TelemetryEvent): Promise<void> {
    await insertEvents(pool, [event]);
    await pool.query(
      "UPDATE telemetry_events SET created_at = $1 WHERE id = (SELECT max(id) FROM telemetry_events)",
      [createdAtIso],
    );
  }

  const SINCE = new Date("2026-08-01T00:00:00.000Z");

  describe("getLlmCallStatsSince", () => {
    it("sums/counts across a mix of llm.call success and error rows, excluding tool.call/turn rows", async () => {
      await insertEventAt("2026-08-10T00:00:00.000Z", {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 100,
        outputTokens: 20,
        cacheHitTokens: 40,
        durationMs: 500,
        costUsd: 0.01,
      });
      await insertEventAt("2026-08-11T00:00:00.000Z", {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 50,
        outputTokens: 10,
        cacheHitTokens: 5,
        durationMs: 300,
        costUsd: 0,
        error: "HTTP 500",
      });
      await insertEventAt("2026-08-12T00:00:00.000Z", {
        name: "tool.call",
        threadId: "t1",
        turnId: "turn1",
        tool: "search",
        durationMs: 100,
        approved: true,
      });
      await insertEventAt("2026-08-13T00:00:00.000Z", {
        name: "turn",
        threadId: "t1",
        turnId: "turn1",
        iterations: 2,
        totalCostUsd: 0.02,
        outcome: "completed",
        durationMs: 1000,
      });

      const stats = await getLlmCallStatsSince(pool, SINCE);

      expect(stats).toEqual({
        calls: 2,
        errorCalls: 1,
        inputTokens: 150,
        outputTokens: 30,
        cacheHitTokens: 45,
      });
    });

    it("excludes rows dated before sinceUtc", async () => {
      await insertEventAt("2026-07-31T23:59:59.999Z", {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 999,
        outputTokens: 999,
        cacheHitTokens: 999,
        durationMs: 1,
        costUsd: 1,
      });
      await insertEventAt("2026-08-01T00:00:00.000Z", {
        name: "llm.call",
        threadId: null,
        turnId: null,
        model: "deepseek-v4-flash",
        inputTokens: 1,
        outputTokens: 1,
        cacheHitTokens: 0,
        durationMs: 1,
        costUsd: 0.001,
      });

      const stats = await getLlmCallStatsSince(pool, SINCE);

      expect(stats).toEqual({
        calls: 1,
        errorCalls: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheHitTokens: 0,
      });
    });

    it("returns all-zero stats when no llm.call rows exist", async () => {
      const stats = await getLlmCallStatsSince(pool, SINCE);

      expect(stats).toEqual({
        calls: 0,
        errorCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
      });
    });
  });

  describe("getTopToolsSince", () => {
    it("groups and orders tool.call rows by tool_name, most-called first", async () => {
      const toolCall = (tool: string): TelemetryEvent => ({
        name: "tool.call",
        threadId: "t1",
        turnId: "turn1",
        tool,
        durationMs: 10,
        approved: true,
      });

      await insertEventAt("2026-08-10T00:00:00.000Z", toolCall("search"));
      await insertEventAt("2026-08-10T00:00:01.000Z", toolCall("search"));
      await insertEventAt("2026-08-10T00:00:02.000Z", toolCall("lookup"));

      const topTools = await getTopToolsSince(pool, SINCE, 10);

      expect(topTools).toEqual([
        { tool: "search", count: 2 },
        { tool: "lookup", count: 1 },
      ]);
    });

    it("returns [] when no tool.call rows exist", async () => {
      const topTools = await getTopToolsSince(pool, SINCE, 10);

      expect(topTools).toEqual([]);
    });
  });
});
