import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claim, complete } from "../llm-dedupe-repo";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("llm-dedupe-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves the
    // migration itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM llm_dedupe");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("a first claim on a new key returns claimed", async () => {
    const result = await claim(pool, "telegram:1");
    expect(result).toEqual({ status: "claimed" });
  });

  it("a second claim on the same still-pending key also returns claimed (documented retry case)", async () => {
    await claim(pool, "telegram:2");
    const result = await claim(pool, "telegram:2");
    expect(result).toEqual({ status: "claimed" });
  });

  it("after complete(), a further claim returns completed with the stored resultText", async () => {
    await claim(pool, "telegram:3");
    await complete(pool, "telegram:3", "the stored reply");

    const result = await claim(pool, "telegram:3");
    expect(result).toEqual({ status: "completed", resultText: "the stored reply" });
  });

  it("rejects a raw duplicate INSERT on the same dedupe_key via the primary-key constraint itself, not application logic", async () => {
    await claim(pool, "telegram:4");

    await expect(
      pool.query("INSERT INTO llm_dedupe (dedupe_key) VALUES ($1)", ["telegram:4"]),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
