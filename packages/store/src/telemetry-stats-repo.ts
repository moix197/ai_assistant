import type { Pool } from "pg";

export interface LlmCallStats {
  calls: number;
  errorCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}

export interface TopToolCount {
  tool: string;
  count: number;
}

interface LlmCallStatsRow {
  calls: number;
  error_calls: number;
  input_tokens: string;
  output_tokens: string;
  cache_hit_tokens: string;
}

/**
 * One aggregate query over `llm.call` rows since `sinceUtc` — token sums are
 * pulled from `fields->>'inputTokens'` etc. (cast to numeric) since those are
 * not fixed columns. Deliberately has no cost/dollar field: `/stats`' spend
 * line comes from `@hermes/store`'s `sumCostSince` (against `llm_usage`)
 * instead, never from here — see the cost-source-split invariant in
 * `plans/02-telemetry.md`. Do not add one without a deliberate, separate
 * decision, even if it seems convenient for a future feature.
 */
export async function getLlmCallStatsSince(pool: Pool, sinceUtc: Date): Promise<LlmCallStats> {
  const result = await pool.query<LlmCallStatsRow>(
    `SELECT
       COUNT(*)::int AS calls,
       COUNT(*) FILTER (WHERE is_error)::int AS error_calls,
       COALESCE(SUM((fields->>'inputTokens')::numeric), 0) AS input_tokens,
       COALESCE(SUM((fields->>'outputTokens')::numeric), 0) AS output_tokens,
       COALESCE(SUM((fields->>'cacheHitTokens')::numeric), 0) AS cache_hit_tokens
     FROM telemetry_events
     WHERE name = 'llm.call' AND created_at >= $1`,
    [sinceUtc],
  );
  const row = result.rows[0];
  return {
    calls: row?.calls ?? 0,
    errorCalls: row?.error_calls ?? 0,
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheHitTokens: Number(row?.cache_hit_tokens ?? 0),
  };
}

/**
 * Groups `tool.call` rows since `sinceUtc` by `tool_name`, most-called first.
 * Returns `[]` (not an error, not `null`) when no `tool.call` rows exist in
 * the window — `packages/agent`'s tool loop (`finishToolCall` in
 * `src/loop.ts`) emits a `tool.call` event for every tool invocation, so `[]`
 * means "no tool calls in the window", never "no producer exists".
 */
export async function getTopToolsSince(
  pool: Pool,
  sinceUtc: Date,
  limit: number,
): Promise<TopToolCount[]> {
  const result = await pool.query<TopToolCount>(
    `SELECT tool_name AS tool, COUNT(*)::int AS count
     FROM telemetry_events
     WHERE name = 'tool.call' AND created_at >= $1
     GROUP BY tool_name
     ORDER BY count DESC
     LIMIT $2`,
    [sinceUtc, limit],
  );
  return result.rows;
}
