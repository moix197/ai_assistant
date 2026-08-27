import type { Env } from "@hermes/config";
import type { LlmUsageEntry, Logger } from "@hermes/core";
import {
  type LlmProvider,
  type ProviderProfile,
  createOpenAiCompatibleAdapter,
  resolveBudgetCapUsd,
} from "@hermes/llm";
import { type Pool, recordUsage, sumCostSince } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";

/**
 * Wires the OpenAI-compatible adapter to real infrastructure: usage rows
 * persisted through `@hermes/store`'s `recordUsage` against the live pool,
 * the app's real logger — not the adapter's no-op `logger` default, which
 * would otherwise silently disable the usage-recording-failure and
 * telemetry-drop warnings — and the monthly budget ceiling (Phase 4), backed
 * by the same pool via `sumCostSince` and
 * `resolveBudgetCapUsd(env)`. `usageRepo` and `budget` are both mandatory on
 * the adapter now specifically so this is the one place that can wire them;
 * omitting either here is a compile error, not a silent no-op. Extracted
 * from `boot()` so this wiring is testable without booting the whole
 * process, matching `build-provider-profiles.ts`'s shape.
 *
 * `signal` (Phase 5) is optional and passed straight through to the
 * adapter's own optional `signal` option -- `boot.ts` supplies its
 * boot-lifetime `AbortController`'s signal here; omitting it (as every test
 * of this function does) leaves the adapter's per-request timeout as the
 * only abort mechanism, unchanged from before this phase.
 *
 * `recorder` (Phase 2b) is optional and passed straight through to the
 * adapter's own optional `recorder` option -- `boot.ts` supplies its
 * boot-lifetime `TelemetryRecorderHandle` here. Threading it through this
 * one function, rather than letting a caller reach for
 * `createOpenAiCompatibleAdapter` directly, is what keeps the real
 * construction site from silently dropping it the way `usageRepo` and
 * `dedupeRepo` were once dropped (see `plans/02-telemetry.md`).
 */
export function buildLlmProvider(
  pool: Pool,
  profile: ProviderProfile,
  logger: Logger,
  env: Env,
  signal?: AbortSignal,
  recorder?: TelemetryRecorderHandle,
): LlmProvider {
  const usageRepo = { recordUsage: (entry: LlmUsageEntry) => recordUsage(pool, entry) };
  const budget = {
    usageRepo: { sumCostSince: (sinceUtc: Date) => sumCostSince(pool, sinceUtc) },
    capUsd: resolveBudgetCapUsd(env),
  };
  return createOpenAiCompatibleAdapter(profile, { usageRepo, logger, budget, signal, recorder });
}
