import { type Pool, getLlmCallStatsSince, getTopToolsSince, sumCostSince } from "@hermes/store";
import type { StatsRepo } from "@hermes/telemetry";

/**
 * Wires `/stats`' `StatsRepo` port to real infrastructure: `@hermes/store`'s
 * `sumCostSince`, `getLlmCallStatsSince`, and `getTopToolsSince` against the
 * live pool. `sumCostSince` is the **same** function
 * `apps/hermes/src/llm/build-llm-provider.ts` wires into the budget
 * ceiling's `BudgetUsageRepo` — the wiring, not just the type shape, is what
 * makes the cost-source-split invariant hold. Extracted from `boot()` so
 * this wiring is testable without booting the whole process, matching
 * `build-llm-provider.ts`'s shape.
 */
export function buildStatsRepo(pool: Pool): StatsRepo {
  return {
    sumCostSince: (sinceUtc: Date) => sumCostSince(pool, sinceUtc),
    getLlmCallStatsSince: (sinceUtc: Date) => getLlmCallStatsSince(pool, sinceUtc),
    getTopToolsSince: (sinceUtc: Date, limit: number) => getTopToolsSince(pool, sinceUtc, limit),
  };
}
