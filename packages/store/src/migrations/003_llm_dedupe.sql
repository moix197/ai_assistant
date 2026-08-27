-- One row per dedupe key the completion handler has claimed. The primary
-- key on dedupe_key is what makes the exact-duplicate-delivery case a
-- Postgres guarantee, not an application check-then-insert race: two
-- concurrent claims for the same key can only ever have one INSERT winner.
-- See llm-dedupe-repo.ts and packages/store/README.md for the three states
-- (claimed / pending-retry / completed) and the claim-to-complete
-- crash-window accepted risk.
CREATE TABLE llm_dedupe (
  dedupe_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  result_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
