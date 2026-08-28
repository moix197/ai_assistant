/**
 * Provider-neutral shapes for LLM interaction. Owned by `@hermes/core` so
 * `store` (Phase 3+) and `agent` (2c) can depend on them without ever
 * importing `@hermes/llm` directly — no vendor-shaped (e.g. OpenAI wire
 * format) type escapes `packages/llm`. `@hermes/llm`'s own
 * adapter-construction shapes (e.g. `ProviderProfile`) stay in that package;
 * they are not domain types other packages need to share.
 *
 * `Message` and its four role variants are schema-first: each a `z.object`,
 * the union a `z.discriminatedUnion("role", ...)`, and the exported TS types
 * are `z.infer<typeof ...>` rather than hand-written interfaces. This is what
 * lets `@hermes/store` validate a `threads.messages` jsonb row against the
 * exact shape the rest of the codebase compiles against (`parseValidatedJson`,
 * `packages/store/src/validate-row.ts`) with no second, hand-synced schema to
 * drift — see `.ai/decisions/tool-call-wire-format.md`.
 */
import { z } from "zod";

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const systemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof systemMessageSchema>;

export const userMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
});
export type UserMessage = z.infer<typeof userMessageSchema>;

export const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  /**
   * Present when the model requested one or more tool calls this turn — the
   * wire format's assistant `tool_calls` message that must precede the
   * `role: "tool"` result messages answering it.
   */
  toolCalls: z.array(toolCallSchema).optional(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const toolMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.string(),
  /** The id of the `ToolCall` this message answers. Mandatory, not optional:
   * a `role: "tool"` message without one is meaningless on the wire (every
   * OpenAI-compatible provider rejects it), so it is unrepresentable here
   * rather than checked at the adapter boundary. See
   * `.ai/decisions/tool-call-wire-format.md`. */
  toolCallId: z.string(),
});
export type ToolMessage = z.infer<typeof toolMessageSchema>;

/**
 * Discriminated on `role` so a `role: "tool"` message missing `toolCallId`,
 * or a non-assistant message carrying `toolCalls`, is a compile error, and
 * (via `messageSchema`) a runtime validation failure, instead of a
 * runtime-optional field callers must remember to guard.
 */
export const messageSchema = z.discriminatedUnion("role", [
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);
export type Message = z.infer<typeof messageSchema>;

/** Validates a stored `threads.messages` jsonb array — see `@hermes/store`'s `parseValidatedJson`. */
export const messagesArraySchema = z.array(messageSchema);

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
