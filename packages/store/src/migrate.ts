import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_TABLE = "schema_migrations";

/**
 * The migrations directory always lives at `<package root>/src/migrations`,
 * both in dev (running src/migrate.ts directly) and once bundled (the
 * bundler inlines this code into dist/index.js, one level below package
 * root too) — so resolving "../package.json" relative to *this file's own*
 * location and re-joining "src/migrations" is stable across both cases.
 */
export function getDefaultMigrationsDir(): string {
  const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  return path.join(packageRoot, "src", "migrations");
}

export function sortMigrationFilenames(filenames: string[]): string[] {
  return filenames.filter((name) => name.endsWith(".sql")).sort();
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrationIds(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  return new Set(result.rows.map((row) => row.id));
}

async function applyMigration(pool: Pool, id: string, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`, [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readMigrationFilenames(migrationsDir: string): Promise<string[]> {
  try {
    return await readdir(migrationsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Ensures the tracking table exists, then applies every not-yet-applied
 * `NNN_*.sql` file in filename order, each in its own transaction. Aborts on
 * the first failing migration — it is not recorded as applied, and no later
 * migration runs.
 */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedMigrationIds(pool);
  const filenames = sortMigrationFilenames(await readMigrationFilenames(migrationsDir));

  for (const filename of filenames) {
    if (applied.has(filename)) continue;
    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    await applyMigration(pool, filename, sql);
  }
}
