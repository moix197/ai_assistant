import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOffset, setOffset } from "../telegram-offset-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("telegram-offset-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await pool.query("DROP TABLE IF EXISTS telegram_offset");
    await pool.query(`
      CREATE TABLE telegram_offset (
        id smallint PRIMARY KEY DEFAULT 1,
        update_id bigint NOT NULL DEFAULT 0,
        CHECK (id = 1)
      )
    `);
    await pool.query("INSERT INTO telegram_offset (id, update_id) VALUES (1, 0)");
  });

  afterEach(async () => {
    await pool.query("DROP TABLE IF EXISTS telegram_offset").catch(() => {});
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
