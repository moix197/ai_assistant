import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export interface WaitForDatabaseOptions {
  retries?: number;
  delayMs?: number;
}

/**
 * `depends_on: condition: service_healthy` in docker-compose only gates
 * container *start* order, not the instant Postgres accepts connections —
 * this retries a trivial query before boot proceeds, so a slow-to-accept
 * Postgres doesn't crash-loop hermes on the first connection attempt.
 */
export async function waitForDatabase(
  pool: Pool,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const retries = options.retries ?? 10;
  const delayMs = options.delayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
