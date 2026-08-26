import type { LlmUsageEntry, Logger } from "@hermes/core";
import { type LlmProvider, type ProviderProfile, createOpenAiCompatibleAdapter } from "@hermes/llm";
import { type Pool, recordUsage } from "@hermes/store";

/**
 * Wires the OpenAI-compatible adapter to real infrastructure: usage rows
 * persisted through `@hermes/store`'s `recordUsage` against the live pool,
 * and the app's real logger — not the adapter's no-op `usageRepo`/`logger`
 * defaults, which would otherwise silently disable cost recording and the
 * unknown-model warn. Extracted from `boot()` so this wiring is testable
 * without booting the whole process, matching `build-provider-profiles.ts`'s
 * shape.
 */
export function buildLlmProvider(
  pool: Pool,
  profile: ProviderProfile,
  logger: Logger,
): LlmProvider {
  const usageRepo = { recordUsage: (entry: LlmUsageEntry) => recordUsage(pool, entry) };
  return createOpenAiCompatibleAdapter(profile, { usageRepo, logger });
}
