import type { Pool } from "pg";

export interface GmailSendLogClaimInput {
  channel: string;
  channelUserId: string;
  turnId: string;
  tool: string;
  canonicalArgs: unknown;
  draftId: string;
}

/**
 * Writes the `awaiting_approval` intent row `gmail-send-draft.ts`'s
 * `prepare` records **before** any human has seen a prompt — an intent, not
 * a claim and never a grant (see `010_gmail_send_log.sql`'s header comment).
 * `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`: atomic, so a throw
 * mid-call (e.g. the connection drops) leaves either a clean insert or no
 * row at all, never a half-written row a later `claim` could misread. A
 * repeat call for the same key (e.g. `prepare` running twice against an
 * identical same-turn retry before either is approved) is a harmless no-op
 * — the existing row is left untouched.
 */
export async function recordIntent(
  pool: Pool,
  dedupeKey: string,
  input: GmailSendLogClaimInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO gmail_send_log
       (dedupe_key, channel, channel_user_id, turn_id, tool, canonical_args, draft_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_approval')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      dedupeKey,
      input.channel,
      input.channelUserId,
      input.turnId,
      input.tool,
      JSON.stringify(input.canonicalArgs),
      input.draftId,
    ],
  );
}

export type GmailSendLogClaimResult =
  | "claimed"
  | { alreadyComplete: true; outcome: unknown }
  | { alreadyPending: true };

/**
 * Claims `dedupeKey` for the handler's actual send attempt, run only after a
 * human has approved — the same three outcomes `sheet-write-log-repo.ts`'s
 * `claim` returns:
 * - the row was `awaiting_approval` and transitions to `pending` ->
 *   `"claimed"`, this call now owns sending
 * - the row is `complete` -> `{alreadyComplete: true, outcome}`, the stored
 *   result of the original call — the caller returns this directly and
 *   makes **zero** further Gmail API calls
 * - the row is still `pending` -> `{alreadyPending: true}`, the same
 *   not-fail-open hedge `sheet_write_log` uses: some other call — possibly
 *   this exact send genuinely still in flight, possibly a prior attempt that
 *   crashed after the send landed but before `complete()` recorded it —
 *   already started it, and resending is never safe
 *
 * An `awaiting_approval` row is never itself a short-circuit for anything —
 * only the transition out of it, driven by this function, means a send is
 * about to be attempted. A row missing entirely (no `prepare` ever ran for
 * this key, e.g. a direct test call) defensively inserts fresh as `pending`
 * and claims — the same "the key must always resolve to a definite state"
 * posture the rest of this repo takes, since Postgres's own primary-key
 * constraint on `dedupe_key`, not application check-then-insert, is what
 * makes this race-free under concurrent claims.
 */
export async function claim(
  pool: Pool,
  dedupeKey: string,
  input: GmailSendLogClaimInput,
): Promise<GmailSendLogClaimResult> {
  const updateResult = await pool.query(
    `UPDATE gmail_send_log
     SET status = 'pending'
     WHERE dedupe_key = $1 AND status = 'awaiting_approval'
     RETURNING dedupe_key`,
    [dedupeKey],
  );
  if ((updateResult.rowCount ?? 0) > 0) {
    return "claimed";
  }

  const selectResult = await pool.query<{ status: string; outcome: unknown }>(
    "SELECT status, outcome FROM gmail_send_log WHERE dedupe_key = $1",
    [dedupeKey],
  );
  const row = selectResult.rows[0];
  if (row?.status === "complete") {
    return { alreadyComplete: true, outcome: row.outcome };
  }
  if (row?.status === "pending") {
    return { alreadyPending: true };
  }

  // No row at all (and not the awaiting_approval->pending transition above,
  // which already returned) — defensively insert fresh as pending and claim.
  const insertResult = await pool.query(
    `INSERT INTO gmail_send_log
       (dedupe_key, channel, channel_user_id, turn_id, tool, canonical_args, draft_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [
      dedupeKey,
      input.channel,
      input.channelUserId,
      input.turnId,
      input.tool,
      JSON.stringify(input.canonicalArgs),
      input.draftId,
    ],
  );
  if ((insertResult.rowCount ?? 0) > 0) {
    return "claimed";
  }

  // Lost a concurrent insert race — re-select and resolve the same way as
  // above; the row now definitely exists in some state.
  const raceResult = await pool.query<{ status: string; outcome: unknown }>(
    "SELECT status, outcome FROM gmail_send_log WHERE dedupe_key = $1",
    [dedupeKey],
  );
  const raceRow = raceResult.rows[0];
  if (raceRow?.status === "complete") {
    return { alreadyComplete: true, outcome: raceRow.outcome };
  }
  return { alreadyPending: true };
}

/** Marks `dedupeKey` complete, storing `outcome` for a future duplicate claim within the same turn to short-circuit against — never called with the now-gone `draftId`, since `drafts.send` deletes the draft it sends (the sent message id lives in `outcome` instead). */
export async function complete(pool: Pool, dedupeKey: string, outcome: unknown): Promise<void> {
  await pool.query(
    "UPDATE gmail_send_log SET status = 'complete', outcome = $2, completed_at = now() WHERE dedupe_key = $1",
    [dedupeKey, JSON.stringify(outcome)],
  );
}

/**
 * Deletes `dedupeKey`'s row, but only while it's still `pending` — released
 * only after a *provably-definitive* send failure (a non-429 4xx, or an
 * exhausted 429 that never got applied), so a legitimate same-turn retry
 * isn't permanently blocked by `alreadyPending`'s fail-closed hedge over a
 * send that definitely never landed. The `status = 'pending'` guard means
 * this can never delete a row a genuine `complete()` already recorded, even
 * if called racily — see `gmail-send-draft.ts`'s definitive-vs-ambiguous
 * split for which failures qualify. Never call this for a genuinely
 * ambiguous failure (a post-send timeout, a 5xx after the request left) —
 * those keep the row `pending` so the fail-closed `ambiguous_send` hedge
 * still applies to a same-turn retry.
 */
export async function release(pool: Pool, dedupeKey: string): Promise<void> {
  await pool.query("DELETE FROM gmail_send_log WHERE dedupe_key = $1 AND status = 'pending'", [
    dedupeKey,
  ]);
}

export interface GmailSendLogIntent {
  dedupeKey: string;
  status: "awaiting_approval" | "pending" | "complete";
  draftId: string;
  outcome: unknown;
  createdAt: Date;
}

/**
 * The post-restart reporting seam: the newest `gmail_send_log` row for this
 * `(channel, channelUserId)` created at or after `sinceMs` (epoch
 * milliseconds), or `undefined` when none exists in that window. Read-only —
 * this is the **only** thing a stale row is ever used for beyond a call's own
 * `claim`/`complete`/`release` against its own key: describing, to a human,
 * what is or isn't true about a send that may have been mid-approval when the
 * process last restarted. Never consulted to decide whether to send anything.
 */
export async function findLatestIntent(
  pool: Pool,
  channel: string,
  channelUserId: string,
  sinceMs: number,
): Promise<GmailSendLogIntent | undefined> {
  const result = await pool.query<{
    dedupe_key: string;
    status: "awaiting_approval" | "pending" | "complete";
    draft_id: string;
    outcome: unknown;
    created_at: Date;
  }>(
    `SELECT dedupe_key, status, draft_id, outcome, created_at
     FROM gmail_send_log
     WHERE channel = $1 AND channel_user_id = $2 AND created_at >= $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [channel, channelUserId, new Date(sinceMs)],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    dedupeKey: row.dedupe_key,
    status: row.status,
    draftId: row.draft_id,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}
