import { type GoogleAccount, googleAccountSchema } from "@hermes/core";
import type { Pool } from "pg";
import { parseValidatedJson } from "./validate-row";

export type { GoogleAccount };

interface GoogleAccountRow {
  channel: string;
  channel_user_id: string;
  chat_id: string;
  google_email: string;
  /** Unvalidated as read from `pg` — `toGoogleAccount` runs the whole mapped row through `parseValidatedJson` before trusting its shape. */
  scopes: unknown;
  token_envelope: unknown;
  expires_at: Date;
}

function toGoogleAccount(row: GoogleAccountRow): GoogleAccount {
  const candidate = {
    channel: row.channel,
    channelUserId: row.channel_user_id,
    chatId: row.chat_id,
    googleEmail: row.google_email,
    scopes: row.scopes,
    tokenEnvelope: row.token_envelope,
    expiresAt: row.expires_at,
  };
  return parseValidatedJson(googleAccountSchema, candidate, "google_accounts");
}

export async function getAccount(
  pool: Pool,
  channel: string,
  channelUserId: string,
): Promise<GoogleAccount | undefined> {
  const result = await pool.query<GoogleAccountRow>(
    "SELECT * FROM google_accounts WHERE channel = $1 AND channel_user_id = $2",
    [channel, channelUserId],
  );
  const row = result.rows[0];
  return row ? toGoogleAccount(row) : undefined;
}

/**
 * `ON CONFLICT (channel, channel_user_id) DO UPDATE` — the first `DO UPDATE`
 * in this codebase, a deliberate exception to the `DO NOTHING`-only
 * precedent `thread-repo.ts`/`llm-dedupe-repo.ts` set: unlike `threads`/
 * `llm_dedupe`, reconnecting the same identity must overwrite the old token,
 * not silently keep it.
 */
export async function upsertAccount(pool: Pool, account: GoogleAccount): Promise<void> {
  await pool.query(
    `INSERT INTO google_accounts
       (channel, channel_user_id, chat_id, google_email, scopes, token_envelope, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (channel, channel_user_id) DO UPDATE SET
       chat_id = EXCLUDED.chat_id,
       google_email = EXCLUDED.google_email,
       scopes = EXCLUDED.scopes,
       token_envelope = EXCLUDED.token_envelope,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      account.channel,
      account.channelUserId,
      account.chatId,
      account.googleEmail,
      account.scopes,
      JSON.stringify(account.tokenEnvelope),
      account.expiresAt,
    ],
  );
}

/**
 * UPDATE-only, deliberately *not* an upsert: a token refresh must never create
 * a row. If `/disconnect` deleted the row while the refresh HTTP call was in
 * flight, this matches nothing and the disconnect stands, instead of the sweep
 * resurrecting the account with a live refresh token. Writing only the token
 * columns likewise keeps a `/connect` that landed mid-sweep from having its
 * freshly-granted `scopes`/`chat_id` clobbered by the sweep's stale snapshot.
 */
export async function updateRefreshedTokens(pool: Pool, account: GoogleAccount): Promise<void> {
  await pool.query(
    `UPDATE google_accounts
        SET token_envelope = $3, expires_at = $4, updated_at = now()
      WHERE channel = $1 AND channel_user_id = $2`,
    [
      account.channel,
      account.channelUserId,
      JSON.stringify(account.tokenEnvelope),
      account.expiresAt,
    ],
  );
}

export async function deleteAccount(
  pool: Pool,
  channel: string,
  channelUserId: string,
): Promise<void> {
  await pool.query("DELETE FROM google_accounts WHERE channel = $1 AND channel_user_id = $2", [
    channel,
    channelUserId,
  ]);
}

/**
 * Rows whose `expires_at` falls before `cutoff` — `apps/hermes/src/google/
 * refresh-sweep.ts` calls this with `cutoff` derived from
 * `@hermes/google-auth`'s `REFRESH_SKEW_MS`, so the sweep's notion of
 * "expiring soon" and `getValidAccessToken`'s own staleness check read from
 * the same constant. Uses the `google_accounts_expires_at_idx` index from
 * migration `007`.
 */
export async function listAccountsExpiringBefore(
  pool: Pool,
  cutoff: Date,
): Promise<GoogleAccount[]> {
  const result = await pool.query<GoogleAccountRow>(
    "SELECT * FROM google_accounts WHERE expires_at < $1",
    [cutoff],
  );
  return result.rows.map(toGoogleAccount);
}

/**
 * A refresh failure classified `invalid_grant` (revoked or expired) leaves
 * an account no more usable than one the operator ran `/disconnect` on —
 * removing the row is the same action, keeping `whoami`/`/status` on the one
 * "not connected" path with no separate disconnected-but-present state to
 * reason about.
 */
export async function markDisconnected(
  pool: Pool,
  channel: string,
  channelUserId: string,
): Promise<void> {
  await deleteAccount(pool, channel, channelUserId);
}
