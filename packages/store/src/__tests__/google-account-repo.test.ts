import type { GoogleAccount } from "@hermes/google-auth";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteAccount,
  getAccount,
  listAccountsExpiringBefore,
  markDisconnected,
  upsertAccount,
} from "../google-account-repo";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

function account(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "user-1",
    chatId: "chat-1",
    googleEmail: "person@example.com",
    scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    tokenEnvelope: { v: 1, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" },
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe.skipIf(!testDatabaseUrl)("google-account-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM google_accounts");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("returns undefined when no account exists", async () => {
    await expect(getAccount(pool, "telegram", "nobody")).resolves.toBeUndefined();
  });

  it("round-trips the account, including token_envelope byte-for-byte as opaque JSON", async () => {
    const seeded = account();
    await upsertAccount(pool, seeded);

    const fetched = await getAccount(pool, "telegram", "user-1");

    expect(fetched).toEqual(seeded);
  });

  it("upserting twice for the same (channel, channel_user_id) overwrites rather than duplicating", async () => {
    await upsertAccount(pool, account({ googleEmail: "first@example.com" }));
    await upsertAccount(
      pool,
      account({
        googleEmail: "second@example.com",
        tokenEnvelope: { v: 1, iv: "bmV3", tag: "dGFnMg==", ct: "Y3Qy" },
      }),
    );

    const fetched = await getAccount(pool, "telegram", "user-1");
    expect(fetched?.googleEmail).toBe("second@example.com");
    expect(fetched?.tokenEnvelope).toEqual({ v: 1, iv: "bmV3", tag: "dGFnMg==", ct: "Y3Qy" });

    const countResult = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM google_accounts WHERE channel = $1 AND channel_user_id = $2",
      ["telegram", "user-1"],
    );
    expect(countResult.rows[0]?.count).toBe("1");
  });

  it("reconnect upsert preserves the original created_at while advancing updated_at", async () => {
    await upsertAccount(pool, account({ googleEmail: "first@example.com" }));
    const before = await pool.query<{ created_at: Date; updated_at: Date }>(
      "SELECT created_at, updated_at FROM google_accounts WHERE channel = $1 AND channel_user_id = $2",
      ["telegram", "user-1"],
    );

    // now() is transaction-start time in Postgres, so back-to-back upserts in
    // the same millisecond can otherwise report an identical updated_at.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await upsertAccount(
      pool,
      account({
        googleEmail: "second@example.com",
        tokenEnvelope: { v: 1, iv: "bmV3", tag: "dGFnMg==", ct: "Y3Qy" },
      }),
    );
    const after = await pool.query<{ created_at: Date; updated_at: Date }>(
      "SELECT created_at, updated_at FROM google_accounts WHERE channel = $1 AND channel_user_id = $2",
      ["telegram", "user-1"],
    );

    expect(after.rows[0]?.created_at).toEqual(before.rows[0]?.created_at);
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );
  });

  it("deleteAccount removes the row", async () => {
    await upsertAccount(pool, account());
    await deleteAccount(pool, "telegram", "user-1");

    await expect(getAccount(pool, "telegram", "user-1")).resolves.toBeUndefined();
  });

  it("listAccountsExpiringBefore returns only accounts under the cutoff", async () => {
    await upsertAccount(
      pool,
      account({ channelUserId: "expiring", expiresAt: new Date("2026-08-28T00:00:00.000Z") }),
    );
    await upsertAccount(
      pool,
      account({ channelUserId: "fresh", expiresAt: new Date("2026-10-01T00:00:00.000Z") }),
    );

    const results = await listAccountsExpiringBefore(pool, new Date("2026-09-01T00:00:00.000Z"));

    expect(results).toHaveLength(1);
    expect(results[0]?.channelUserId).toBe("expiring");
  });

  it("markDisconnected removes the row", async () => {
    await upsertAccount(pool, account());
    await markDisconnected(pool, "telegram", "user-1");

    await expect(getAccount(pool, "telegram", "user-1")).resolves.toBeUndefined();
  });

  it("rejects a hand-corrupted row on read instead of silently returning cast garbage", async () => {
    await upsertAccount(pool, account());

    await pool.query(
      "UPDATE google_accounts SET token_envelope = $2::jsonb WHERE channel_user_id = $1",
      ["user-1", JSON.stringify({ bogus: "shape" })],
    );

    await expect(getAccount(pool, "telegram", "user-1")).rejects.toThrow(/google_accounts/);
  });
});
