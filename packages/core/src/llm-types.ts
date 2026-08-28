/**
 * Provider-neutral shapes for LLM interaction. Owned by `@hermes/core` so
 * `store` (Phase 3+) and `agent` (2c) can depend on them without ever
 * importing `@hermes/llm` directly — no vendor-shaped (e.g. OpenAI wire
 * format) type escapes `packages/llm`. `@hermes/llm`'s own
 * adapter-construction shapes (e.g. `ProviderProfile`) stay in that package;
 * they are not domain types other packages need to share.
 */

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  /**
   * Present when the model requested one or more tool calls this turn — the
   * wire format's assistant `tool_calls` message that must precede the
   * `role: "tool"` result messages answering it.
   */
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  content: string;
  /** The id of the `ToolCall` this message answers. Mandatory, not optional:
   * a `role: "tool"` message without one is meaningless on the wire (every
   * OpenAI-compatible provider rejects it), so it is unrepresentable here
   * rather than checked at the adapter boundary. See
   * `.ai/decisions/tool-call-wire-format.md`. */
  toolCallId: string;
}

/**
 * Discriminated on `role` so a `role: "tool"` message missing `toolCallId`,
 * or a non-assistant message carrying `toolCalls`, is a compile error instead
 * of a runtime-optional field that adapters must remember to guard.
 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens served from the provider's prefix cache, already counted
   * within `promptTokens` — not additional tokens. `0` when the provider
   * reports no cache info; that's a legitimate "no hit", distinct from a
   * missing `usage` block entirely (which adapters still throw on).
   */
  cacheHitTokens: number;
}

/**
 * One completed LLM call's billed usage and cost, as persisted by
 * `@hermes/store`'s `recordUsage` and consumed by `@hermes/llm`'s adapter via
 * the injected `LlmUsageRepo` port. Lives here, not duplicated in each
 * package, so a field added on one side can't silently fail to persist on
 * the other.
 */
export interface LlmUsageEntry {
  provider: string;
  model: string;
  /** "Miss" prompt tokens only — excludes cacheHitTokens, see `packages/llm/src/pricing.ts`. */
  inputTokens: number;
  /** Includes reasoning/thinking tokens billed as output but invisible in `completionTokens`. */
  outputTokens: number;
  cacheHitTokens: number;
  costUsd: number;
}
