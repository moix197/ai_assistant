import type { Message } from "@hermes/core";

export interface Thread {
  id: string;
  channel: string;
  chatId: string;
  messages: Message[];
}

/**
 * The injected persistence port — `packages/agent` never imports
 * `@hermes/store` directly, the same boundary rule `packages/llm` already
 * follows for `LlmUsageRepo`/`BudgetUsageRepo`.
 * `apps/hermes/src/store/build-thread-repo.ts` wires this to
 * `@hermes/store`'s `getOrCreateThread`/`appendMessages`.
 */
export interface ThreadRepo {
  getOrCreateThread(channel: string, chatId: string): Promise<Thread>;
  appendMessages(threadId: string, messages: Message[]): Promise<void>;
}
