#!/usr/bin/env node
import { getDefaultMigrationsDir, runMigrations } from "../src/migrate";
import { createPool } from "../src/pool";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Missing required environment variable "DATABASE_URL"');
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  try {
    await runMigrations(pool, getDefaultMigrationsDir());
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
