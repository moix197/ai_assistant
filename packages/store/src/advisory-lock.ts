import { createLogger } from "@hermes/core";
import { Client } from "pg";

const logger = createLogger({ fields: { service: "hermes", component: "advisory-lock" } });

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
 * Fail-closed default for a lock connection that dies mid-run. Postgres
 * releases a session-level advisory lock the instant its connection drops, so
 * from that moment a second instance can acquire it while this one keeps
 * polling Telegram and refreshing tokens — the very concurrency the lock
 * exists to prevent, and which `.ai/decisions/google-token-refresh.md` relies
 * on for single-flight refresh correctness. Handled the same way `boot.ts`'s
 * health-server `onError` handles an unrecoverable infrastructure error: log
 * the reason, exit non-zero, let the supervisor restart into a clean
 * acquisition (or into the lost-the-race exit, if another instance now holds
 * it). Without any listener at all this would instead be an uncaught 'error'
 * event: the same death, but as a raw stack trace with no explanation.
 */
function exitAfterLostLockConnection(error: Error): void {
  logger.error("instance lock connection lost, exiting", { error: error.message });
  process.exit(1);
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
 *
 * `onConnectionError` is injectable only so a test can observe the handler
 * without exiting the test runner; every caller uses the default.
 */
export async function acquireInstanceLock(
  lockKey: number,
  databaseUrl: string,
  onConnectionError: (error: Error) => void = exitAfterLostLockConnection,
): Promise<InstanceLock> {
  const client = new Client({ connectionString: databaseUrl });
  client.on("error", onConnectionError);
  await client.connect();

  let acquired: boolean;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    acquired = result.rows[0]?.locked ?? false;
  } catch (error) {
    await client.end();
    throw error;
  }

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
