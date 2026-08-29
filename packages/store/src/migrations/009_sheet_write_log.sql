-- One row per dedupe key `sheets_write` has claimed — the durable write
-- audit for invariant 3 (telemetry_events is buffered/at-most-once, so it
-- cannot be the audit of record for a mutation; this claim-before-call table
-- can). Shape mirrors llm_dedupe's claim/complete idiom exactly
-- (dedupe_key primary key, pending/complete status, an outcome column filled
-- in on complete), widened with the columns that make this table double as
-- an audit trail: channel/channel_user_id/turn_id/tool/canonical_args.
--
-- dedupe_key is a hash of (channel, channel_user_id, turn_id, tool,
-- canonical args) — see canonical-args.ts. turn_id is part of the key on
-- purpose: it's a retry guard against the *model* calling the tool twice
-- with identical args in one turn, not a permanent "this exact write can
-- only ever happen once" block — a later, genuinely repeated user request
-- (a different turn_id) is allowed to proceed. See llm-dedupe-repo.ts and
-- packages/store/README.md for the claim-to-complete crash-window's
-- fail-open (retry, not permanently block) precedent this table follows.
CREATE TABLE sheet_write_log (
  dedupe_key text PRIMARY KEY,
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  turn_id text NOT NULL,
  tool text NOT NULL,
  canonical_args jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'complete')),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
