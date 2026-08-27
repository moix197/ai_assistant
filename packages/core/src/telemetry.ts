// Typed discriminated union on `name`, replacing the original free-form
// `{ name, fields? }` shape now that Phase 1 (plans/02-telemetry.md) ships a
// real recorder to widen it for. `threadId`/`turnId` are nullable on every
// event because `packages/agent` (2c) — the only future owner of real
// thread/turn ids — doesn't exist yet; `packages/llm`'s adapter, the only
// producer this PRD ships, always passes `null` for both.

/** One completed (or failed) LLM provider call. The only event this PRD emits a real producer for. */
export interface LlmCallEvent {
  name: "llm.call";
  threadId: string | null;
  turnId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  durationMs: number;
  costUsd: number;
  error?: string;
}

/**
 * One tool invocation. Defined here so `packages/agent` (2c) has a typed
 * contract to emit into — no producer ships in this PRD.
 */
export interface ToolCallEvent {
  name: "tool.call";
  threadId: string | null;
  turnId: string | null;
  tool: string;
  durationMs: number;
  approved: boolean;
  error?: string;
}

/**
 * A turn's terminal state. Narrowed from `string` (03-agent-core Phase 1,
 * settled decision 13) now that `packages/agent`'s loop is the event's real
 * producer. Deliberately excludes approval denial and a tool-validation
 * failure — neither ends a turn, so neither is an outcome.
 */
export type TurnOutcome = "completed" | "max_iterations" | "aborted" | "error";

/**
 * One agentic-loop turn. Defined here for the same forward-looking reason as
 * `ToolCallEvent` — no producer ships in this PRD.
 */
export interface TurnEvent {
  name: "turn";
  threadId: string | null;
  turnId: string | null;
  iterations: number;
  totalCostUsd: number;
  outcome: TurnOutcome;
  durationMs: number;
}

export type TelemetryEvent = LlmCallEvent | ToolCallEvent | TurnEvent;

export interface TelemetryRecorder {
  record(event: TelemetryEvent): void;
}
