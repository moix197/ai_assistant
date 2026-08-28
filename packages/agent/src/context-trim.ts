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

/**
 * `message.content.length` already covers every role, including a
 * `role: "tool"` message's own result `content` — that part isn't new here.
 * What it misses is an assistant message carrying `toolCalls`: its own
 * `content` is often empty (the wire-format assistant tool-call request, see
 * `loop.ts`), so the actual payload — the requested arguments — lives in
 * `toolCalls` instead. Counting each call's serialized `arguments` alongside
 * `content` is the one addition that lets a tool-heavy turn register against
 * `HISTORY_BUDGET_CHARS` instead of estimating to (near) zero.
 */
function estimateSize(message: Message): number {
  const toolCallsChars =
    message.role === "assistant" && message.toolCalls
      ? message.toolCalls.reduce((sum, call) => sum + JSON.stringify(call.arguments).length, 0)
      : 0;
  return Math.ceil((message.content.length + toolCallsChars) / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Groups `messages` into trim-atomic units: a `role: "assistant"` message
 * carrying `toolCalls` together with every immediately following
 * `role: "tool"` message answering it — the wire-order invariant `loop.ts`
 * establishes guarantees those tool messages are contiguous and come right
 * after it. Every other message is its own single-message group. Trimming
 * must never split a group, or a stored `role: "tool"` message could survive
 * without the assistant `toolCalls` message it answers, which every
 * OpenAI-compatible provider rejects on replay.
 */
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let openForToolResults = false;

  for (const message of messages) {
    if (openForToolResults && message.role === "tool") {
      groups.at(-1)?.push(message);
      continue;
    }
    groups.push([message]);
    openForToolResults = message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0;
  }

  return groups;
}

function estimateGroupSize(group: Message[]): number {
  return group.reduce((sum, message) => sum + estimateSize(message), 0);
}

/**
 * Drops the oldest messages first until the remaining running size estimate
 * fits `budgetChars` — at group granularity (see `groupMessages`), so an
 * assistant-with-toolCalls message and its tool results are always dropped
 * together, never split. Never touches the prefix (`system`/`toolDefs`) —
 * the caller applies this only to stored history. Never receives, and so can
 * never drop, the turn's newest user message: the caller appends that
 * separately, after trimming (see `loop.ts`). Always keeps at least one
 * group: a single group larger than the whole budget is kept rather than
 * trimmed to nothing.
 */
export function trimHistory(messages: Message[], budgetChars: number): Message[] {
  const groups = groupMessages(messages);
  let running = groups.reduce((sum, group) => sum + estimateGroupSize(group), 0);
  let dropCount = 0;

  for (const group of groups) {
    if (running <= budgetChars || dropCount === groups.length - 1) break;
    running -= estimateGroupSize(group);
    dropCount++;
  }

  return groups.slice(dropCount).flat();
}
