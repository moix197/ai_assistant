import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { getOffset, setOffset } from "../telegram-offset-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("telegram-offset-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL, and never drops the
    // table: this suite runs against a real Postgres, and the migration-owned
    // `telegram_offset` table must survive test runs. Idempotent — a no-op
    // once the migration is already applied.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("UPDATE telegram_offset SET update_id = 0 WHERE id = 1");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("returns 0 initially", async () => {
    expect(await getOffset(pool)).toBe(0);
  });

  it("persists a new offset and getOffset reflects it", async () => {
    await setOffset(pool, 42);
    expect(await getOffset(pool)).toBe(42);
  });
});
