import type { LlmUsageEntry } from "@hermes/core";

export type { LlmUsageEntry };

/**
 * Persistence port for recording completed LLM usage — a small interface
 * rather than a direct `@hermes/store` dependency, so `@hermes/llm` stays
 * decoupled from Postgres and the adapter stays testable with a mock.
 * Mirrors `packages/channels`' `TelegramOffsetRepo` shape.
 * `apps/hermes/src/llm/build-llm-provider.ts` wires this to `@hermes/store`'s
 * `recordUsage(pool, entry)`. `LlmUsageEntry` itself lives in `@hermes/core`,
 * shared with `@hermes/store`, so the two sides of this port can't drift.
 */
export interface LlmUsageRepo {
  recordUsage(entry: LlmUsageEntry): Promise<void>;
}
