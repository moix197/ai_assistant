import type { Message } from "@hermes/core";
import type { Pool } from "pg";

export interface Thread {
  id: string;
  channel: string;
  chatId: string;
  messages: Message[];
}

interface ThreadRow {
  id: string;
  channel: string;
  chat_id: string;
  messages: Message[];
}

function toThread(row: ThreadRow): Thread {
  return { id: row.id, channel: row.channel, chatId: row.chat_id, messages: row.messages };
}

/**
 * `INSERT ... ON CONFLICT (channel, chat_id) DO NOTHING RETURNING *`, then a
 * `SELECT` on conflict — the same shape `llm-dedupe-repo.ts`'s `claim` uses,
 * the only existing upsert idiom in this package. `ON CONFLICT DO UPDATE` is
 * deliberately not introduced as a new pattern here. The unique constraint on
 * `(channel, chat_id)` is what makes "one thread per chat" a Postgres
 * guarantee, not an application check-then-insert race.
 */
export async function getOrCreateThread(
  pool: Pool,
  channel: string,
  chatId: string,
): Promise<Thread> {
  const insertResult = await pool.query<ThreadRow>(
    `INSERT INTO threads (channel, chat_id) VALUES ($1, $2)
     ON CONFLICT (channel, chat_id) DO NOTHING RETURNING *`,
    [channel, chatId],
  );
  const insertedRow = insertResult.rows[0];
  if (insertedRow) return toThread(insertedRow);

  const selectResult = await pool.query<ThreadRow>(
    "SELECT * FROM threads WHERE channel = $1 AND chat_id = $2",
    [channel, chatId],
  );
  const row = selectResult.rows[0];
  if (!row) {
    throw new Error(
      `getOrCreateThread: no row found for (${channel}, ${chatId}) after a failed insert`,
    );
  }
  return toThread(row);
}

/**
 * Appends without clobbering existing entries — `messages || $2::jsonb`, not
 * a replace — so a concurrent read never sees a partial write. Bumps
 * `updated_at`.
 */
export async function appendMessages(
  pool: Pool,
  threadId: string,
  newMessages: Message[],
): Promise<void> {
  await pool.query(
    "UPDATE threads SET messages = messages || $2::jsonb, updated_at = now() WHERE id = $1",
    [threadId, JSON.stringify(newMessages)],
  );
}
