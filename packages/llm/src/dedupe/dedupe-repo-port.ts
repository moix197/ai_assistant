/**
 * Shared TS shape for the dedupe repo port. **Not** used by `@hermes/llm`
 * itself — dedupe is an application-level concern per decision (the
 * completion handler owns claiming, not the adapter). This file exists only
 * so `apps/hermes` has a clean, published-surface type to import, mirroring
 * `usage/usage-repo-port.ts`'s `LlmUsageRepo` pattern. `apps/hermes/src/
 * boot.ts` wires this to `@hermes/store`'s `claim(pool, dedupeKey)` /
 * `complete(pool, dedupeKey, resultText)`.
 */
export type LlmDedupeClaimResult =
  | { status: "claimed" }
  | { status: "completed"; resultText: string };

export interface LlmDedupeRepo {
  claim(dedupeKey: string): Promise<LlmDedupeClaimResult>;
  complete(dedupeKey: string, resultText: string): Promise<void>;
}
