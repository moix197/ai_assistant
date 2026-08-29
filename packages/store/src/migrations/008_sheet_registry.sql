-- Operator-registered spreadsheets, one row per short `slug` a chat user or
-- future dashboard refers to instead of a raw spreadsheet id/URL. Keyed by
-- `slug` alone, not `(channel, channel_user_id)`: unlike `google_accounts`,
-- a registered sheet is operator-level configuration shared across every
-- connected identity in this single-tenant deployment, not per-user data.
--
-- `access` gates whether a write tool may target this sheet; a CHECK
-- constraint is the one source of truth for the valid values — application
-- code never hand-mirrors this set except to reject bad input before it
-- reaches Postgres (see `sheets-cli.ts`). `value_input_option` is the
-- per-sheet default for how Sheets parses cell content on write, overridable
-- per call once a write tool exists.
CREATE TABLE sheet_registry (
  slug text PRIMARY KEY,
  spreadsheet_id text NOT NULL,
  description text NOT NULL DEFAULT '',
  access text NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'readwrite')),
  value_input_option text NOT NULL DEFAULT 'USER_ENTERED'
    CHECK (value_input_option IN ('RAW', 'USER_ENTERED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
