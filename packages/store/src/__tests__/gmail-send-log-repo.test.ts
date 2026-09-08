import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claim, complete, findLatestIntent, recordIntent, release } from "../gmail-send-log-repo";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

const INTENT_INPUT = {
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
  tool: "gmail_send_draft",
  canonicalArgs: { draftId: "draft-1" },
  draftId: "draft-1",
};

describe.skipIf(!testDatabaseUrl)("gmail-send-log-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves migration
    // 010 itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM gmail_send_log");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("recordIntent writes an awaiting_approval row, idempotent on repeat", async () => {
    await recordIntent(pool, "key-1", INTENT_INPUT);
    await recordIntent(pool, "key-1", INTENT_INPUT);

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM gmail_send_log WHERE dedupe_key = $1",
      ["key-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("awaiting_approval");
  });

  it("claim transitions an awaiting_approval row to pending and returns claimed", async () => {
    await recordIntent(pool, "key-2", INTENT_INPUT);

    const result = await claim(pool, "key-2", INTENT_INPUT);

    expect(result).toBe("claimed");
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM gmail_send_log WHERE dedupe_key = $1",
      ["key-2"],
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("a second claim on the same still-pending key returns alreadyPending, not claimed — no double-send on a same-turn retry", async () => {
    await recordIntent(pool, "key-3", INTENT_INPUT);
    await claim(pool, "key-3", INTENT_INPUT);

    const result = await claim(pool, "key-3", INTENT_INPUT);

    expect(result).toEqual({ alreadyPending: true });
  });

  it("after complete(), a further claim returns the stored outcome instead of sending again", async () => {
    await recordIntent(pool, "key-4", INTENT_INPUT);
    await claim(pool, "key-4", INTENT_INPUT);
    const outcome = { ok: true, messageId: "msg-1" };
    await complete(pool, "key-4", outcome);

    const result = await claim(pool, "key-4", INTENT_INPUT);

    expect(result).toEqual({ alreadyComplete: true, outcome });
  });

  it("a missing row (no prior recordIntent) defensively inserts as pending and claims", async () => {
    const result = await claim(pool, "key-5", INTENT_INPUT);

    expect(result).toBe("claimed");
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM gmail_send_log WHERE dedupe_key = $1",
      ["key-5"],
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("release() deletes a still-pending row, freeing the key for a fresh claim", async () => {
    await recordIntent(pool, "key-6", INTENT_INPUT);
    await claim(pool, "key-6", INTENT_INPUT);

    await release(pool, "key-6");

    const { rows } = await pool.query("SELECT 1 FROM gmail_send_log WHERE dedupe_key = $1", [
      "key-6",
    ]);
    expect(rows).toHaveLength(0);
    // The key is fully free again — a fresh claim on it defensively inserts.
    const result = await claim(pool, "key-6", INTENT_INPUT);
    expect(result).toBe("claimed");
  });

  it("release() never deletes an already-complete row, even if called against it by mistake", async () => {
    await recordIntent(pool, "key-7", INTENT_INPUT);
    await claim(pool, "key-7", INTENT_INPUT);
    const outcome = { ok: true, messageId: "msg-1" };
    await complete(pool, "key-7", outcome);

    await release(pool, "key-7");

    const result = await claim(pool, "key-7", INTENT_INPUT);
    expect(result).toEqual({ alreadyComplete: true, outcome });
  });

  it("release() never deletes a still-awaiting_approval row — it only ever releases a pending claim", async () => {
    await recordIntent(pool, "key-8", INTENT_INPUT);

    await release(pool, "key-8");

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM gmail_send_log WHERE dedupe_key = $1",
      ["key-8"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("awaiting_approval");
  });

  it("findLatestIntent returns the newest row within the window and nothing outside it", async () => {
    await recordIntent(pool, "key-9", INTENT_INPUT);
    const beforeSecond = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordIntent(pool, "key-10", { ...INTENT_INPUT, turnId: "turn-2" });

    const result = await findLatestIntent(pool, "telegram", "111", beforeSecond);

    expect(result?.dedupeKey).toBe("key-10");
    expect(result?.status).toBe("awaiting_approval");
    expect(result?.draftId).toBe("draft-1");

    const future = Date.now() + 60_000;
    const nothing = await findLatestIntent(pool, "telegram", "111", future);
    expect(nothing).toBeUndefined();
  });

  it("findLatestIntent scopes to the given channel/channelUserId, never a different user's row", async () => {
    await recordIntent(pool, "key-11", { ...INTENT_INPUT, channelUserId: "other-user" });

    const result = await findLatestIntent(pool, "telegram", "111", 0);

    expect(result).toBeUndefined();
  });

  it("rejects a raw duplicate INSERT on the same dedupe_key via the primary-key constraint itself, not application logic", async () => {
    await recordIntent(pool, "key-12", INTENT_INPUT);

    await expect(
      pool.query(
        `INSERT INTO gmail_send_log
           (dedupe_key, channel, channel_user_id, turn_id, tool, canonical_args, draft_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_approval')`,
        [
          "key-12",
          INTENT_INPUT.channel,
          INTENT_INPUT.channelUserId,
          INTENT_INPUT.turnId,
          INTENT_INPUT.tool,
          JSON.stringify(INTENT_INPUT.canonicalArgs),
          INTENT_INPUT.draftId,
        ],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
