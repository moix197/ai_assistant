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
  const tableName = `test_items_${randomUUID().replace(/-/g, "")}`;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    migrationsDir = await mkdtemp(path.join(tmpdir(), "hermes-migrations-"));
    await pool.query("DROP TABLE IF EXISTS schema_migrations");
  });

  afterEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => {});
    await pool.query("DROP TABLE IF EXISTS schema_migrations").catch(() => {});
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it("creates the tracking table, applies migrations once, and no-ops on re-run", async () => {
    await writeFile(
      path.join(migrationsDir, "001_create_table.sql"),
      `CREATE TABLE ${tableName} (id serial PRIMARY KEY)`,
    );

    await runMigrations(pool, migrationsDir);
    const firstRun = await pool.query("SELECT id FROM schema_migrations");
    expect(firstRun.rows).toHaveLength(1);

    await runMigrations(pool, migrationsDir);
    const secondRun = await pool.query("SELECT id FROM schema_migrations");
    expect(secondRun.rows).toHaveLength(1);
  });

  it("aborts on a failing migration and does not record it as applied", async () => {
    await writeFile(path.join(migrationsDir, "001_bad.sql"), "NOT VALID SQL;");

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow();
    const applied = await pool.query("SELECT id FROM schema_migrations");
    expect(applied.rows).toHaveLength(0);
  });
});
