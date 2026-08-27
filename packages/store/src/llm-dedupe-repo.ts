import type { Pool } from "pg";

export type LlmDedupeClaimResult =
  | { status: "claimed" }
  | { status: "completed"; resultText: string };

/**
 * Claims `dedupeKey` via `INSERT ... ON CONFLICT DO NOTHING RETURNING` — the
 * primary-key constraint on `llm_dedupe.dedupe_key` is what makes the
 * uniqueness a Postgres guarantee, not an application check-then-insert
 * race: two concurrent claims for the same key can only ever have one
 * winner.
 *
 * Three outcomes:
 * - the INSERT wins (no row existed) -> `{status: "claimed"}`, first call
 * - the row exists and is `completed` -> `{status: "completed", resultText}`,
 *   the stored reply from the original call
 * - the row exists and is still `pending` (the claim-to-complete crash
 *   window — see packages/store/README.md) -> `{status: "claimed"}` again,
 *   allowing exactly one retry. This is deliberate, fail-open behavior, not
 *   a bug: permanently wedging the message would be worse than a rare,
 *   bounded, low-dollar duplicate call.
 */
export async function claim(pool: Pool, dedupeKey: string): Promise<LlmDedupeClaimResult> {
  const insertResult = await pool.query(
    "INSERT INTO llm_dedupe (dedupe_key) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key",
    [dedupeKey],
  );
  if ((insertResult.rowCount ?? 0) > 0) {
    return { status: "claimed" };
  }

  const selectResult = await pool.query<{ status: string; result_text: string | null }>(
    "SELECT status, result_text FROM llm_dedupe WHERE dedupe_key = $1",
    [dedupeKey],
  );
  const row = selectResult.rows[0];
  if (row?.status === "completed") {
    return { status: "completed", resultText: row.result_text ?? "" };
  }
  // status is "pending" (or the row vanished between the failed INSERT and
  // this SELECT, which can't happen under normal operation) — either way,
  // retry rather than block.
  return { status: "claimed" };
}

/** Marks `dedupeKey` completed, storing `resultText` for future exact-duplicate short-circuits. */
export async function complete(pool: Pool, dedupeKey: string, resultText: string): Promise<void> {
  await pool.query(
    "UPDATE llm_dedupe SET status = 'completed', result_text = $2, completed_at = now() WHERE dedupe_key = $1",
    [dedupeKey, resultText],
  );
}
