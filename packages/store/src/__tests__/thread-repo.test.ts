import type { Message } from "@hermes/core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { appendMessages, getOrCreateThread } from "../thread-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("thread-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    // Seeds via the real migration instead of inline DDL — proves the
    // migration itself applies cleanly, not just a hand-rolled schema.
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM threads");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("a fresh thread starts with an empty messages array", async () => {
    const thread = await getOrCreateThread(pool, "telegram", "555");
    expect(thread.channel).toBe("telegram");
    expect(thread.chatId).toBe("555");
    expect(thread.messages).toEqual([]);
  });

  it("is idempotent for the same (channel, chatId): a second call returns the same row, no duplicate", async () => {
    const first = await getOrCreateThread(pool, "telegram", "555");
    const second = await getOrCreateThread(pool, "telegram", "555");

    expect(second.id).toBe(first.id);

    const countResult = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM threads WHERE channel = $1 AND chat_id = $2",
      ["telegram", "555"],
    );
    expect(countResult.rows[0]?.count).toBe("1");
  });

  it("different chatIds under the same channel get distinct threads", async () => {
    const first = await getOrCreateThread(pool, "telegram", "111");
    const second = await getOrCreateThread(pool, "telegram", "222");

    expect(first.id).not.toBe(second.id);
  });

  it("appendMessages appends without clobbering existing entries, and bumps updated_at", async () => {
    const thread = await getOrCreateThread(pool, "telegram", "555");
    const before = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM threads WHERE id = $1",
      [thread.id],
    );

    const firstBatch: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    await appendMessages(pool, thread.id, firstBatch);

    const secondBatch: Message[] = [
      { role: "user", content: "what did I just say?" },
      { role: "assistant", content: "you said hello" },
    ];
    await appendMessages(pool, thread.id, secondBatch);

    const afterResult = await pool.query<{ messages: Message[]; updated_at: Date }>(
      "SELECT messages, updated_at FROM threads WHERE id = $1",
      [thread.id],
    );
    const row = afterResult.rows[0];
    expect(row?.messages).toEqual([...firstBatch, ...secondBatch]);
    expect(row?.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );
  });
});
