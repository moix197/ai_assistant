#!/usr/bin/env node
import { getDefaultMigrationsDir, runMigrations } from "../src/migrate";
import { createPool } from "../src/pool";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Missing required environment variable "DATABASE_URL"');
  process.exit(1);
}

async function main(): Promise<void> {
  const pool = createPool(databaseUrl as string);
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
