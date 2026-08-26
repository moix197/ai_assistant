import type { Pool } from "pg";

/**
 * Reads the persisted Telegram `update_id` offset. The migration seeds the
 * singleton row with `update_id = 0`, so this always finds a row — there is
 * no "not yet initialized" state to handle.
 */
export async function getOffset(pool: Pool): Promise<number> {
  const result = await pool.query<{ update_id: string }>(
    "SELECT update_id FROM telegram_offset WHERE id = 1",
  );
  return Number(result.rows[0]?.update_id ?? 0);
}

/**
 * Persists the next `update_id` to resume from. Called by the poller only
 * after an update has been fully handled — see
 * packages/channels/src/telegram/poller.ts and packages/channels/README.md
 * for why persisting any earlier would risk losing updates permanently.
 */
export async function setOffset(pool: Pool, updateId: number): Promise<void> {
  await pool.query("UPDATE telegram_offset SET update_id = $1 WHERE id = 1", [updateId]);
}
