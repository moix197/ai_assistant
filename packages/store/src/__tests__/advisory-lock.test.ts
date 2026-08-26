import { randomInt } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../advisory-lock";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("acquireInstanceLock (integration)", () => {
  // A fresh key per test avoids collisions between tests racing on the same key.
  function newLockKey(): number {
    return randomInt(1, 2_147_483_647);
  }

  const cleanupClients: Client[] = [];

  afterEach(async () => {
    for (const client of cleanupClients.splice(0)) {
      await client.end().catch(() => {});
    }
  });

  it("acquires the lock when free", async () => {
    const lockKey = newLockKey();
    const lock = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(lock.acquired).toBe(true);
    await lock.release();
  });

  it("fails a second concurrent acquire on the same key while the first is held", async () => {
    const lockKey = newLockKey();
    const first = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(first.acquired).toBe(true);

    const second = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(second.acquired).toBe(false);

    await second.release();
    await first.release();
  });

  it("frees the lock when the holding connection is closed without calling release()", async () => {
    const lockKey = newLockKey();
    // Simulates a crash: a separate raw client takes the lock and is closed
    // directly, never calling pg_advisory_unlock via release().
    const crashClient = new Client({ connectionString: testDatabaseUrl });
    cleanupClients.push(crashClient);
    await crashClient.connect();
    const result = await crashClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [lockKey],
    );
    expect(result.rows[0]?.locked).toBe(true);
    await crashClient.end();

    const afterCrash = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(afterCrash.acquired).toBe(true);
    await afterCrash.release();
  });

  it("allows a new acquire on the same key after release()", async () => {
    const lockKey = newLockKey();
    const first = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(first.acquired).toBe(true);
    await first.release();

    const second = await acquireInstanceLock(lockKey, testDatabaseUrl as string);
    expect(second.acquired).toBe(true);
    await second.release();
  });
});
