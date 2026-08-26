/**
 * Provider-neutral shapes for LLM interaction. Owned by `@hermes/core` so
 * `store` (Phase 3+) and `agent` (2c) can depend on them without ever
 * importing `@hermes/llm` directly — no vendor-shaped (e.g. OpenAI wire
 * format) type escapes `packages/llm`. `@hermes/llm`'s own
 * adapter-construction shapes (e.g. `ProviderProfile`) stay in that package;
 * they are not domain types other packages need to share.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  /** Present when `role === "tool"`: the id of the `ToolCall` this message answers. */
  toolCallId?: string;
}

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
}
