import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, sortMigrationFilenames } from "../migrate";

describe("sortMigrationFilenames", () => {
  it("sorts migration filenames in ascending order", () => {
    const input = ["003_c.sql", "001_a.sql", "002_b.sql"];
    expect(sortMigrationFilenames(input)).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
  });

  it("ignores non-.sql files", () => {
    const input = ["001_a.sql", "README.md", ".gitkeep"];
    expect(sortMigrationFilenames(input)).toEqual(["001_a.sql"]);
  });

  it("returns an empty array when there are no migrations", () => {
    expect(sortMigrationFilenames([])).toEqual([]);
  });
});

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("runMigrations (integration)", () => {
  let pool: Pool;
  let migrationsDir: string;
  let tableName: string;
  let migrationId: string;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    migrationsDir = await mkdtemp(path.join(tmpdir(), "hermes-migrations-"));
    // Randomized per test: schema_migrations is the real, shared
    // migration-tracking table (the app's own migrations use it too), so
    // this suite must never drop it — a fresh id each run avoids colliding
    // with rows other tests or the real app migrations left behind.
    const suffix = randomUUID().replace(/-/g, "");
    tableName = `test_items_${suffix}`;
    migrationId = `001_create_table_${suffix}.sql`;
  });

  afterEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => {});
    await pool.query("DELETE FROM schema_migrations WHERE id = $1", [migrationId]).catch(() => {});
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it("creates the tracking table, applies migrations once, and no-ops on re-run", async () => {
    await writeFile(
      path.join(migrationsDir, migrationId),
      `CREATE TABLE ${tableName} (id serial PRIMARY KEY)`,
    );

    await runMigrations(pool, migrationsDir);
    const firstRun = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [
      migrationId,
    ]);
    expect(firstRun.rows).toHaveLength(1);

    await runMigrations(pool, migrationsDir);
    const secondRun = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [
      migrationId,
    ]);
    expect(secondRun.rows).toHaveLength(1);
  });

  it("aborts on a failing migration and does not record it as applied", async () => {
    const badMigrationId = `001_bad_${randomUUID().replace(/-/g, "")}.sql`;
    await writeFile(path.join(migrationsDir, badMigrationId), "NOT VALID SQL;");

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow();
    const applied = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [
      badMigrationId,
    ]);
    expect(applied.rows).toHaveLength(0);
  });
});
