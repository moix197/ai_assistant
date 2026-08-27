import type { Message, ToolCall, Usage } from "@hermes/core";

/**
 * The port's own construction input — an already-resolved (base URL, key,
 * model) triple for one provider. Deliberately **not** a `@hermes/core`
 * type: it isn't a provider-neutral domain shape `store`/`agent` need to
 * share, it's `@hermes/llm`'s own adapter-construction shape.
 * `@hermes/config` never constructs one of these itself; that mapping
 * happens once, in `apps/hermes/src/llm/build-provider-profiles.ts`.
 */
export interface ProviderProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A tool made available to the model. Wire-format-complete; no real caller until `packages/agent` (2c). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[] | undefined;
  maxTokens: number;
  /**
   * The calling `packages/agent` turn's thread/turn ids, stamped onto the
   * emitted `llm.call` event instead of the hardcoded `null`s every call
   * carried before `packages/agent` (2c) existed. Required, not
   * optional-with-a-`null`-default — the same reason the boot `AbortSignal`
   * is required on `packages/agent`'s loop: this codebase has twice shipped
   * an optional field the real construction site silently never filled in.
   * `null` is still a valid, real value (e.g. no thread/turn context yet),
   * just never an accidental omission.
   */
  threadId: string | null;
  turnId: string | null;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  /** The same cost `recordCompletionUsage` resolves and records — one derivation, reused, never re-derived by a caller. */
  costUsd: number;
}

/** Provider-neutral port every adapter (OpenAI-compatible today) implements. */
export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
