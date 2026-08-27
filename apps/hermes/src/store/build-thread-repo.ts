import type { ThreadRepo } from "@hermes/agent";
import { appendMessages, type Pool, getOrCreateThread } from "@hermes/store";

/**
 * Wires `@hermes/agent`'s injected `ThreadRepo` port to `@hermes/store`'s
 * real Postgres-backed functions — the same shape `build-llm-provider.ts`
 * uses for `LlmUsageRepo`/`BudgetUsageRepo`. Extracted from `boot()` so this
 * wiring is testable without booting the whole process.
 */
export function buildThreadRepo(pool: Pool): ThreadRepo {
  return {
    getOrCreateThread: (channel: string, chatId: string) => getOrCreateThread(pool, channel, chatId),
    appendMessages: (threadId: string, messages) => appendMessages(pool, threadId, messages),
  };
}
