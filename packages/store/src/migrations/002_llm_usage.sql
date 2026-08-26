-- One row per completed LLM call. cache_hit_tokens is a separate column,
-- never folded into input_tokens: input_tokens holds only the "miss"
-- portion (prompt tokens NOT served from the provider's prefix cache), so
-- the two columns are additive rather than overlapping. See
-- packages/store/README.md and packages/llm/src/pricing.ts.
CREATE TABLE llm_usage (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL,
  output_tokens int NOT NULL,
  cache_hit_tokens int NOT NULL,
  cost_usd numeric(12,6) NOT NULL
);

-- Supports sumCostSince(pool, sinceUtc)'s "WHERE created_at >= $1" access
-- pattern (Phase 4's budget ceiling), the only query this table serves
-- beyond a plain insert.
CREATE INDEX llm_usage_created_at_idx ON llm_usage (created_at);
