import type { LlmUsageEntry } from "@hermes/core";
import type { Pool } from "pg";

export type { LlmUsageEntry };

/**
 * Persists one completed LLM call's usage and cost. Called from
 * `@hermes/llm`'s adapter success path only, via the `LlmUsageRepo` port
 * `apps/hermes/src/boot.ts` wires to this function — see
 * `packages/llm/src/usage/usage-repo-port.ts`.
 */
export async function recordUsage(pool: Pool, entry: LlmUsageEntry): Promise<void> {
  await pool.query(
    `INSERT INTO llm_usage (provider, model, input_tokens, output_tokens, cache_hit_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.provider,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheHitTokens,
      entry.costUsd,
    ],
  );
}

/**
 * Sums `cost_usd` for every row recorded at or after `sinceUtc`. Built now,
 * next to `recordUsage`, because it's the natural home for it — used by
 * Phase 4's budget ceiling, not by anything in this phase.
 */
export async function sumCostSince(pool: Pool, sinceUtc: Date): Promise<number> {
  const result = await pool.query<{ total: string | null }>(
    "SELECT SUM(cost_usd) AS total FROM llm_usage WHERE created_at >= $1",
    [sinceUtc],
  );
  return Number(result.rows[0]?.total ?? 0);
}
