import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordUsage, sumCostSince } from "../llm-usage-repo";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("llm-usage-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves the
    // migration itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM llm_usage");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("round-trips a recorded row, with cache_hit_tokens distinct from input_tokens", async () => {
    await recordUsage(pool, {
      provider: "api.deepseek.com",
      model: "deepseek-v4-flash",
      inputTokens: 70,
      outputTokens: 20,
      cacheHitTokens: 30,
      costUsd: 0.000123,
    });

    const result = await pool.query<{
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_hit_tokens: number;
      cost_usd: string;
    }>(
      "SELECT provider, model, input_tokens, output_tokens, cache_hit_tokens, cost_usd FROM llm_usage",
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.provider).toBe("api.deepseek.com");
    expect(row?.model).toBe("deepseek-v4-flash");
    expect(row?.input_tokens).toBe(70);
    expect(row?.output_tokens).toBe(20);
    expect(row?.cache_hit_tokens).toBe(30);
    expect(row?.cache_hit_tokens).not.toBe(row?.input_tokens);
    expect(Number(row?.cost_usd)).toBeCloseTo(0.000123, 6);
  });

  it("sumCostSince sums cost_usd across multiple rows recorded at or after the given time", async () => {
    // Backdated a second: `created_at` defaults to Postgres `now()`, whose
    // clock is not this process's. A `since` taken from `new Date()` at the
    // same instant intermittently lands *after* the first row's timestamp and
    // drops it from the sum. The window under test is minutes wide, so a
    // second of slack costs the assertion nothing.
    const since = new Date(Date.now() - 1_000);

    await recordUsage(pool, {
      provider: "p",
      model: "m1",
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
      costUsd: 0.001,
    });
    await recordUsage(pool, {
      provider: "p",
      model: "m2",
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
      costUsd: 0.002,
    });

    const total = await sumCostSince(pool, since);
    expect(total).toBeCloseTo(0.003, 6);
  });

  it("sumCostSince excludes rows recorded before the given time", async () => {
    await recordUsage(pool, {
      provider: "p",
      model: "m1",
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
      costUsd: 0.005,
    });

    const farFuture = new Date(Date.now() + 60_000);
    const total = await sumCostSince(pool, farFuture);
    expect(total).toBe(0);
  });
});
