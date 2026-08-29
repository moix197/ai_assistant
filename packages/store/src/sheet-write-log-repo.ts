import type { Pool } from "pg";

export interface SheetWriteLogClaimInput {
  channel: string;
  channelUserId: string;
  turnId: string;
  tool: string;
  canonicalArgs: unknown;
}

export type SheetWriteLogClaimResult =
  | "claimed"
  | { alreadyComplete: true; outcome: unknown }
  | { alreadyPending: true };

/**
 * Claims `dedupeKey` via `INSERT ... ON CONFLICT DO NOTHING RETURNING` —
 * the same shape `llm-dedupe-repo.ts`'s `claim` uses, so the primary-key
 * constraint on `sheet_write_log.dedupe_key` is what makes the uniqueness a
 * Postgres guarantee, not an application check-then-insert race.
 *
 * Three outcomes:
 * - the INSERT wins (no row existed) -> `"claimed"`, first call for this key
 * - the row exists and is `complete` -> `{alreadyComplete: true, outcome}`,
 *   the stored result of the original call — the caller returns this
 *   directly and never calls the Sheets API again
 * - the row exists and is still `pending` -> `{alreadyPending: true}`. This
 *   is deliberately **not** fail-open: a pending row means some other call —
 *   possibly this exact write, genuinely still in flight, possibly a prior
 *   attempt that crashed after the write landed but before `complete()`
 *   recorded it (the claim-to-complete crash window, see
 *   `packages/store/README.md`) — already started this exact write, and we
 *   cannot tell which. Returning `"claimed"` here (the old behavior) let a
 *   same-turn retry call the Sheets API a second time, which can double an
 *   `append`. The caller must surface this as an ambiguous outcome instead
 *   of writing again.
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
  // never proceed to write again; the caller surfaces this as ambiguous.
  return { alreadyPending: true };
}

/** Marks `dedupeKey` complete, storing `outcome` for a future duplicate claim within the same turn to short-circuit against. */
export async function complete(pool: Pool, dedupeKey: string, outcome: unknown): Promise<void> {
  await pool.query(
    "UPDATE sheet_write_log SET status = 'complete', outcome = $2, completed_at = now() WHERE dedupe_key = $1",
    [dedupeKey, JSON.stringify(outcome)],
  );
}

/**
 * Deletes `dedupeKey`'s row, but only while it's still `pending` — releases
 * a claim for a write that provably never reached the sheet (the request
 * reached Google and was rejected outright, or never got past quota
 * enforcement), so a legitimate same-turn retry isn't permanently blocked by
 * `alreadyPending`'s fail-closed hedge over a write that definitely never
 * landed. The `status = 'pending'` guard means a call racing a legitimate
 * `completeSheetWrite` from the attempt that actually owns this claim can
 * never delete an already-completed row out from under it.
 *
 * Never call this for a genuinely ambiguous failure (a post-send timeout, a
 * 5xx after the request reached Google) — those keep the pending row (or, in
 * `sheets-write.ts`'s case, get recorded via `complete` with the ambiguous
 * outcome) so the fail-closed hedge still applies. See `sheets-write.ts`'s
 * `SheetsApiError` handling for which failures qualify as definitive.
 */
export async function release(pool: Pool, dedupeKey: string): Promise<void> {
  await pool.query("DELETE FROM sheet_write_log WHERE dedupe_key = $1 AND status = 'pending'", [
    dedupeKey,
  ]);
}
