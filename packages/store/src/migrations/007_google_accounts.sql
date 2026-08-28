-- One row per connected Google identity, keyed by (channel, channel_user_id)
-- — the same identity the Telegram allowlist already gates on, stable across
-- threads and restarts. `chat_id` is captured at connect time (not derived
-- at alert time) so Phase 4's refresh-failure alert is a column read, not a
-- lookup into an in-memory index that's empty after a restart.
--
-- `token_envelope` is opaque to this package: `packages/google-auth` is the
-- only code that ever decrypts it. `scopes` is the identity/consent scopes
-- granted at connect time, read by the scope registry to decide whether a
-- tool's requirement is already satisfied.
CREATE TABLE google_accounts (
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  chat_id text NOT NULL,
  google_email text NOT NULL,
  scopes text[] NOT NULL,
  token_envelope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, channel_user_id)
);

-- Phase 4's listAccountsExpiringBefore sweep query filters on this column
-- every tick — an unindexed sequential scan is cheap at today's row counts,
-- but there's no reason to ship it unindexed when 006_threads.sql already
-- set the precedent of an explicit named index.
CREATE INDEX google_accounts_expires_at_idx ON google_accounts (expires_at);
