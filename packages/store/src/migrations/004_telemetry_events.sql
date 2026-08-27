-- One row per telemetry event (`@hermes/core`'s `TelemetryEvent` union).
-- Wide-table shape: the columns every query needs to filter/aggregate on
-- (`name`, `thread_id`, `turn_id`, `tool_name`, `duration_ms`, `cost_usd`,
-- `is_error`) are real columns, everything else lives in `fields` jsonb —
-- so the rollup queries this table exists for (Phase 3) are plain SQL
-- aggregates, not application-side scans of a blob column. See
-- packages/store/README.md and packages/telemetry/README.md.
--
-- No retention/pruning policy yet — this table grows unbounded from this
-- migration onward. Explicit open item, not solved here; see
-- .ai/decisions/telemetry-event-schema.md.
CREATE TABLE telemetry_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  thread_id text,
  turn_id text,
  tool_name text,
  duration_ms int,
  cost_usd numeric(12,6),
  is_error boolean NOT NULL DEFAULT false,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Supports the "since" window every rollup query in Phase 3 filters on
-- (today / this calendar month), same access pattern as llm_usage_created_at_idx.
CREATE INDEX telemetry_events_created_at_idx ON telemetry_events (created_at);

-- Supports "count of a given event name since <time>" (calls, error rate,
-- cache-hit rate — all filtered on name = 'llm.call' first).
CREATE INDEX telemetry_events_name_created_at_idx ON telemetry_events (name, created_at);

-- Supports getTopToolsSince's GROUP BY tool_name over tool.call rows.
CREATE INDEX telemetry_events_tool_name_idx ON telemetry_events (tool_name);
