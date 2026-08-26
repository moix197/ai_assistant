import type { Clock } from "@hermes/core";
import { BudgetExceededError } from "../errors";

/**
 * The subset of usage-repo persistence this check needs. A small injected
 * port rather than a direct `@hermes/store` dependency, mirroring
 * `usage-repo-port.ts`'s `LlmUsageRepo` shape — `apps/hermes` wires this to
 * `@hermes/store`'s `sumCostSince(pool, sinceUtc)`.
 */
export interface BudgetUsageRepo {
  sumCostSince(sinceUtc: Date): Promise<number>;
}

/** Midnight UTC on the first of `now`'s calendar month, in UTC. */
function startOfCurrentUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Sums spend recorded since the start of the current calendar month (UTC),
 * via the injected `usageRepo`, and throws `BudgetExceededError` when that
 * sum meets or exceeds `capUsd`. The month boundary is computed from the
 * injected `Clock` rather than `new Date()` directly, so this is testable
 * without waiting for a real month rollover.
 *
 * This gates the *next* call against spend already recorded, not spend
 * still in flight — see `packages/llm/README.md` for the accepted
 * one-call-wide window this leaves around the exact cap.
 */
export async function assertBudgetNotExceeded(
  usageRepo: BudgetUsageRepo,
  capUsd: number,
  clock: Clock,
): Promise<void> {
  const sinceUtc = startOfCurrentUtcMonth(clock.now());
  const spentUsd = await usageRepo.sumCostSince(sinceUtc);
  if (spentUsd >= capUsd) {
    throw new BudgetExceededError(capUsd, spentUsd);
  }
}
