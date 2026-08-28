// Typed discriminated union on `name`, replacing the original free-form
// `{ name, fields? }` shape now that Phase 1 (plans/02-telemetry.md) ships a
// real recorder to widen it for. `threadId`/`turnId` stay nullable on every
// event because `null` is a real value, not a placeholder for a missing
// owner: `packages/agent`'s `runTurn` (`loop.ts`) generates `turnId` before
// its thread loads and leaves `threadId` `null` until it does, then stamps
// both onto `CompletionRequest` (`packages/llm/src/port.ts`), which
// `packages/llm`'s adapter forwards onto the `llm.call` event it emits.

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

/** One tool invocation. `packages/agent`'s tool loop (`finishToolCall` in `src/loop.ts`) is its producer. */
export interface ToolCallEvent {
  name: "tool.call";
  threadId: string | null;
  turnId: string | null;
  tool: string;
  /** Handler execution time only — excludes any approval wait, see `approvalWaitMs`. */
  durationMs: number;
  approved: boolean;
  /**
   * Time spent waiting on `ApprovalGate.requestApproval` — present (possibly
   * `0`) only for a call that went through the gate, `undefined` for an
   * ungated call. Split out of `durationMs` so a denied/timed-out gated
   * call's multi-minute approval wait no longer gets misattributed to
   * handler time.
   */
  approvalWaitMs?: number;
  error?: string;
}

/**
 * A turn's terminal state. Narrowed from `string` (03-agent-core Phase 1,
 * settled decision 13) now that `packages/agent`'s loop is the event's real
 * producer. Deliberately excludes approval denial and a tool-validation
 * failure — neither ends a turn, so neither is an outcome.
 */
export type TurnOutcome = "completed" | "max_iterations" | "aborted" | "error";

/** One agentic-loop turn. `packages/agent`'s `runTurn` (`src/loop.ts`) is its producer. */
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
