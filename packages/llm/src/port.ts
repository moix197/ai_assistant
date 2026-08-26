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
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

/** Provider-neutral port every adapter (OpenAI-compatible today) implements. */
export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
