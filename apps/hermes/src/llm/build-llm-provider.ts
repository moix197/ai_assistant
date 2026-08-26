import type { Env } from "@hermes/config";
import type { LlmUsageEntry, Logger } from "@hermes/core";
import {
  type LlmProvider,
  type ProviderProfile,
  createOpenAiCompatibleAdapter,
  resolveBudgetCapUsd,
} from "@hermes/llm";
import { type Pool, recordUsage, sumCostSince } from "@hermes/store";

/**
 * Wires the OpenAI-compatible adapter to real infrastructure: usage rows
 * persisted through `@hermes/store`'s `recordUsage` against the live pool,
 * the app's real logger — not the adapter's no-op `logger` default, which
 * would otherwise silently disable the unknown-model warn — and the monthly
 * budget ceiling (Phase 4), backed by the same pool via `sumCostSince` and
 * `resolveBudgetCapUsd(env)`. `usageRepo` and `budget` are both mandatory on
 * the adapter now specifically so this is the one place that can wire them;
 * omitting either here is a compile error, not a silent no-op. Extracted
 * from `boot()` so this wiring is testable without booting the whole
 * process, matching `build-provider-profiles.ts`'s shape.
 */
export function buildLlmProvider(
  pool: Pool,
  profile: ProviderProfile,
  logger: Logger,
  env: Env,
): LlmProvider {
  const usageRepo = { recordUsage: (entry: LlmUsageEntry) => recordUsage(pool, entry) };
  const budget = {
    usageRepo: { sumCostSince: (sinceUtc: Date) => sumCostSince(pool, sinceUtc) },
    capUsd: resolveBudgetCapUsd(env),
  };
  return createOpenAiCompatibleAdapter(profile, { usageRepo, logger, budget });
}
