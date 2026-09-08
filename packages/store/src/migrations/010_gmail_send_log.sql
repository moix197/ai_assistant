-- One row per dedupe key `gmail_send_draft` has recorded — modeled on
-- `009_sheet_write_log.sql` (dedupe_key primary key, pending/complete status
-- idiom, canonical_args audit column), widened with one extra state ahead of
-- the claim: 'awaiting_approval'. A row is an INTENT RECORD, NEVER A GRANT —
-- it is written by `prepare`, before a human has approved anything, purely
-- so that after a crash mid-approval something durable exists to *report*
-- against ("did it send?"). No code path may ever treat this row's presence,
-- status, or content as authorization to call Gmail's send endpoint; the
-- only two things a row is ever read for are (1) the claim/complete dance a
-- human-approved handler call performs against its OWN row, and (2) a
-- post-restart report to a human describing what did or did not happen.
--
-- Lifecycle: awaiting_approval (prepare, carries no consent) -> pending (the
-- claim, written by the handler immediately before it calls Gmail, after
-- approval) -> complete (the outcome, recorded after the call resolves).
--
-- dedupe_key is a hash of (channel, channel_user_id, turn_id, tool,
-- canonical args) — see @hermes/google-gmail's canonical-args.ts. turn_id is
-- part of the key on purpose: it's a same-turn retry guard against the
-- *model* calling gmail_send_draft twice with identical args in one turn,
-- never a permanent "this draft can only ever be sent once" block — a later,
-- genuinely repeated user request (a different turn_id) is a fresh key and
-- goes through prepare and a brand-new approval prompt exactly like the
-- first send did.
--
-- draft_id is stored separately (not just inside canonical_args) because
-- drafts.send deletes the draft resource it sends — complete() stores the
-- resulting sent message id in outcome, never a second draft_id.
CREATE TABLE gmail_send_log (
  dedupe_key text PRIMARY KEY,
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  turn_id text NOT NULL,
  tool text NOT NULL,
  canonical_args jsonb NOT NULL,
  draft_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_approval', 'pending', 'complete')),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Backs the post-restart lookup: the newest intent for a given
-- (channel, channel_user_id) within a recent time window.
CREATE INDEX gmail_send_log_channel_user_created_at_idx
  ON gmail_send_log (channel, channel_user_id, created_at DESC);
