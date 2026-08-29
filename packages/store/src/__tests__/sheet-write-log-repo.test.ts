import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { claim, complete } from "../sheet-write-log-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

const CLAIM_INPUT = {
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
  tool: "sheets_write",
  canonicalArgs: { mode: "append", sheet: "clients", values: [["Jane", "555-0100"]] },
};

describe.skipIf(!testDatabaseUrl)("sheet-write-log-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves migration
    // 009 itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM sheet_write_log");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("a first claim on a new key returns claimed", async () => {
    const result = await claim(pool, "key-1", CLAIM_INPUT);
    expect(result).toBe("claimed");
  });

  it("a second claim on the same still-pending key returns alreadyPending, not claimed — no double-write on a same-turn retry", async () => {
    await claim(pool, "key-2", CLAIM_INPUT);
    const result = await claim(pool, "key-2", CLAIM_INPUT);
    expect(result).toEqual({ alreadyPending: true });
  });

  it("after complete(), a further claim returns the stored outcome instead of calling the API again", async () => {
    await claim(pool, "key-3", CLAIM_INPUT);
    const outcome = { ok: true, sheet: "clients", mode: "append", updatedRows: 1 };
    await complete(pool, "key-3", outcome);

    const result = await claim(pool, "key-3", CLAIM_INPUT);
    expect(result).toEqual({ alreadyComplete: true, outcome });
  });

  it("rejects a raw duplicate INSERT on the same dedupe_key via the primary-key constraint itself, not application logic", async () => {
    await claim(pool, "key-4", CLAIM_INPUT);

    await expect(
      pool.query(
        `INSERT INTO sheet_write_log
           (dedupe_key, channel, channel_user_id, turn_id, tool, canonical_args, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [
          "key-4",
          CLAIM_INPUT.channel,
          CLAIM_INPUT.channelUserId,
          CLAIM_INPUT.turnId,
          CLAIM_INPUT.tool,
          JSON.stringify(CLAIM_INPUT.canonicalArgs),
        ],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
