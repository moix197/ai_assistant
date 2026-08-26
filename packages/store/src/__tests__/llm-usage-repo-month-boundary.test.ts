import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sumCostSince } from "../llm-usage-repo";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { testDatabaseUrl } from "./db-env";

/**
 * Integration coverage for Phase 4's month-boundary behavior, built on the
 * same `sumCostSince` time-boundary query `llm-usage-repo.test.ts` exercises.
 * That existing suite has shown one intermittent failure (row landing just
 * outside a `since` computed from `new Date()`, most likely a small clock
 * skew between the Node process and the Postgres server) — every row and
 * boundary here is an explicit, injected timestamp rather than `new Date()`
 * racing the server's own clock, so this suite is deterministic regardless
 * of that skew.
 */
describe.skipIf(!testDatabaseUrl)("sumCostSince (month boundary, integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM llm_usage");
  });

  afterEach(async () => {
    await pool.end();
  });

  async function insertUsageRowAt(createdAtIso: string, costUsd: number): Promise<void> {
    await pool.query(
      `INSERT INTO llm_usage (created_at, provider, model, input_tokens, output_tokens, cache_hit_tokens, cost_usd)
       VALUES ($1, 'p', 'm', 1, 1, 0, $2)`,
      [createdAtIso, costUsd],
    );
  }

  it("excludes a row dated last calendar month (UTC) from the current month's sum", async () => {
    const startOfAugustUtc = new Date("2026-08-01T00:00:00.000Z");
    await insertUsageRowAt("2026-07-31T23:59:59.999Z", 0.01);
    await insertUsageRowAt("2026-08-15T12:00:00.000Z", 0.02);

    const total = await sumCostSince(pool, startOfAugustUtc);

    expect(total).toBeCloseTo(0.02, 6);
  });

  it("includes a row dated exactly at the month-boundary second", async () => {
    const startOfAugustUtc = new Date("2026-08-01T00:00:00.000Z");
    await insertUsageRowAt("2026-08-01T00:00:00.000Z", 0.03);

    const total = await sumCostSince(pool, startOfAugustUtc);

    expect(total).toBeCloseTo(0.03, 6);
  });

  it("sums multiple rows within the current month while excluding prior-month rows", async () => {
    const startOfAugustUtc = new Date("2026-08-01T00:00:00.000Z");
    await insertUsageRowAt("2026-07-01T00:00:00.000Z", 100);
    await insertUsageRowAt("2026-07-31T23:59:59.999Z", 100);
    await insertUsageRowAt("2026-08-01T00:00:00.000Z", 0.01);
    await insertUsageRowAt("2026-08-20T09:30:00.000Z", 0.02);

    const total = await sumCostSince(pool, startOfAugustUtc);

    expect(total).toBeCloseTo(0.03, 6);
  });
});
