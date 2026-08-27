-- Resolves the cost_usd double-count 02-telemetry deferred (see
-- .ai/decisions/telemetry-event-schema.md and 03-agent-core's settled
-- decision 1): a `turn` row's total cost gets its own column so `cost_usd`
-- keeps exactly one meaning everywhere — the cost of a single `llm.call`.
-- From this migration onward, `turn` rows write here and leave `cost_usd`
-- NULL; `llm.call`/`tool.call` rows are unaffected and leave this column
-- NULL. Additive, no backfill needed: existing `turn` rows, if any, simply
-- keep `total_cost_usd` NULL.
ALTER TABLE telemetry_events ADD COLUMN total_cost_usd numeric(12,6);
