import type { Pool } from "pg";

export interface SheetWriteLogClaimInput {
  channel: string;
  channelUserId: string;
  turnId: string;
  tool: string;
  canonicalArgs: unknown;
}

export type SheetWriteLogClaimResult = "claimed" | { alreadyComplete: true; outcome: unknown };

/**
 * Claims `dedupeKey` via `INSERT ... ON CONFLICT DO NOTHING RETURNING` —
 * the same shape `llm-dedupe-repo.ts`'s `claim` uses, so the primary-key
 * constraint on `sheet_write_log.dedupe_key` is what makes the uniqueness a
 * Postgres guarantee, not an application check-then-insert race.
 *
 * Two outcomes:
 * - the INSERT wins (no row existed) -> `"claimed"`, first call for this key
 * - the row exists and is `complete` -> `{alreadyComplete: true, outcome}`,
 *   the stored result of the original call — the caller returns this
 *   directly and never calls the Sheets API again
 * - the row exists and is still `pending` (the claim-to-complete crash
 *   window, see `packages/store/README.md`'s "Claim-to-complete crash
 *   window" section) -> `"claimed"` again, the same fail-open (retry, not
 *   permanently block) posture `llm_dedupe` already takes.
 */
export async function claim(
  pool: Pool,
  dedupeKey: string,
  input: SheetWriteLogClaimInput,
): Promise<SheetWriteLogClaimResult> {
  const insertResult = await pool.query(
    `INSERT INTO sheet_write_log
       (dedupe_key, channel, channel_user_id, turn_id, tool, canonical_args, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [
      dedupeKey,
      input.channel,
      input.channelUserId,
      input.turnId,
      input.tool,
      JSON.stringify(input.canonicalArgs),
    ],
  );
  if ((insertResult.rowCount ?? 0) > 0) {
    return "claimed";
  }

  const selectResult = await pool.query<{ status: string; outcome: unknown }>(
    "SELECT status, outcome FROM sheet_write_log WHERE dedupe_key = $1",
    [dedupeKey],
  );
  const row = selectResult.rows[0];
  if (row?.status === "complete") {
    return { alreadyComplete: true, outcome: row.outcome };
  }
  // status is "pending" (or the row vanished between the failed INSERT and
  // this SELECT, which can't happen under normal operation) — either way,
  // allow the retry through rather than permanently wedging the write.
  return "claimed";
}

/** Marks `dedupeKey` complete, storing `outcome` for a future duplicate claim within the same turn to short-circuit against. */
export async function complete(pool: Pool, dedupeKey: string, outcome: unknown): Promise<void> {
  await pool.query(
    "UPDATE sheet_write_log SET status = 'complete', outcome = $2, completed_at = now() WHERE dedupe_key = $1",
    [dedupeKey, JSON.stringify(outcome)],
  );
}
