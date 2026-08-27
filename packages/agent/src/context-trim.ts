import type { Message } from "@hermes/core";

/**
 * The project's standing crude token estimate (settled decision 9): an exact
 * tokenizer-accurate budget is Phase 8's job, deliberately out of scope here
 * (see `plans/03-agent-core.md`). `content.length / 4` is cheap and close
 * enough to bound a request's size — never used to decide what's stored,
 * only what's still attached to a given call.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * The stored-history budget `runTurn` trims against before every call, in
 * the same chars/4 estimated-size units `estimateSize` below produces —
 * package-internal, not env-configurable, the same posture
 * `@hermes/telemetry`'s `maxBufferSize` has.
 */
export const HISTORY_BUDGET_CHARS = 8_000;

function estimateSize(message: Message): number {
  return Math.ceil(message.content.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Drops the oldest messages first until the remaining running size estimate
 * fits `budgetChars`. Never touches the prefix (`system`/`toolDefs`) — the
 * caller applies this only to stored history. Never receives, and so can
 * never drop, the turn's newest user message: the caller appends that
 * separately, after trimming (see `loop.ts`). Always keeps at least one
 * message: a single message larger than the whole budget is kept rather than
 * trimmed to nothing.
 */
export function trimHistory(messages: Message[], budgetChars: number): Message[] {
  let running = messages.reduce((sum, message) => sum + estimateSize(message), 0);
  let dropCount = 0;

  for (const message of messages) {
    if (running <= budgetChars || dropCount === messages.length - 1) break;
    running -= estimateSize(message);
    dropCount++;
  }

  return messages.slice(dropCount);
}
