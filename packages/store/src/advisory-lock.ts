import { Client } from "pg";

/**
 * Fixed, arbitrary lock key for the single-Hermes-instance constraint.
 * Telegram allows exactly one `getUpdates` consumer per bot token, so at most
 * one Hermes instance may run against a given database at a time. Stable by
 * convention: changing this value would let an old and a new instance run
 * concurrently without conflicting, defeating the whole point.
 */
export const INSTANCE_LOCK_KEY = 837_452_910;

export interface InstanceLock {
  acquired: boolean;
  /** Releases the lock (if held) and always closes the dedicated connection. */
  release(): Promise<void>;
}

/**
 * Tries to acquire a Postgres session-level advisory lock on a dedicated
 * `pg.Client` opened outside the shared pool. Session-level advisory locks
 * are tied to the connection that took them — a pooled connection could be
 * handed to unrelated queries or recycled, silently dropping the lock, so
 * this must never run on a connection borrowed from the pool.
 *
 * A session-level lock is also released automatically when its connection
 * closes for any reason (including a crash), which is why an unreleased lock
 * from a dead instance never permanently blocks a new one.
 */
export async function acquireInstanceLock(
  lockKey: number,
  databaseUrl: string,
): Promise<InstanceLock> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [lockKey],
  );
  const acquired = result.rows[0]?.locked ?? false;

  return {
    acquired,
    async release(): Promise<void> {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      }
      await client.end();
    },
  };
}
