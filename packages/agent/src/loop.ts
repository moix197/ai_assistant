import type { Message, TelemetryEvent, TelemetryRecorder, ToolCall } from "@hermes/core";
import { delay, newId } from "@hermes/core";
import { LlmAbortedError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";
import type { ApprovalGate, ApprovalRequest } from "./approval-gate-port";
import { HISTORY_BUDGET_CHARS, trimHistory } from "./context-trim";
import { assemblePrefix } from "./prompt";
import type { Thread, ThreadRepo } from "./thread-repo-port";
import type { AgentDefinition, ToolSpec } from "./types";

/**
 * Bounds the whole turn's model round-trips. Reached whenever the model keeps
 * emitting tool calls instead of a final text response — see the tool loop
 * below.
 */
export const MAX_ITERATIONS = 8;

/**
 * Bounds a single tool handler invocation, independent of the turn-level
 * iteration cap above — a handler that never resolves must not stall the
 * whole turn. Package-internal, not env-configurable, same posture as
 * `MAX_ITERATIONS`/`HISTORY_BUDGET_CHARS`.
 */
const TOOL_HANDLER_TIMEOUT_MS = 10_000;

/** Matches `02-telemetry`'s settled decision 14 bound on `llm.call`'s `error` field — applied here for `tool.call`. */
const TOOL_ERROR_MAX_CHARS = 500;

/**
 * Fed back to the model, verbatim, for a gated call the human denied, let
 * time out, or that got swept up in a shutdown abort mid-wait — settled
 * decision 7's single code path treats all three the same way.
 */
const APPROVAL_DENIED_MESSAGE = "user did not approve";

export interface RunTurnDeps {
  llmProvider: LlmProvider;
  threadRepo: ThreadRepo;
  telemetryRecorder?: TelemetryRecorder;
  /**
   * Required, not optional: the boot `AbortSignal`, checked before any LLM
   * call is attempted. Deliberate reaction to `02-telemetry` Phase 6's own
   * "mechanism built but never wired" bug — see `plans/03-agent-core.md`'s
   * Dependencies & Risks.
   */
  signal: AbortSignal;
  /**
   * Required once any tool in `definition.tools` sets `requiresApproval:
   * true` — enforced by `assertApprovalGateConfigured` in
   * `packages/agent/src/index.ts`'s `createAgent`, called synchronously at
   * construction, before any I/O, so a gated tool configured with no gate
   * supplied fails fast at boot rather than silently never asking. Optional
   * otherwise: a tool-less or ungated-only definition has nothing to gate.
   */
  approvalGate?: ApprovalGate;
}

/**
 * Thrown internally when the loop exhausts `MAX_ITERATIONS` without a final
 * text response. Carries the real accumulated cost/iteration count so the
 * `turn` event reflects the paid calls that actually happened — the generic
 * `"error"`/`"aborted"` paths below report the same real accumulated values
 * via `TurnProgress`, since a provider throw (e.g. `UnpricedModelError`) can
 * land after several iterations already billed, not just the first.
 */
class MaxIterationsReachedError extends Error {
  constructor(
    public readonly totalCostUsd: number,
    public readonly iterations: number,
  ) {
    super("agent turn reached MAX_ITERATIONS without a final response");
    this.name = "MaxIterationsReachedError";
  }
}

/**
 * Mutable accumulator threaded into `converse()` so `runTurn`'s generic
 * catch branch can report the real number of iterations reached and cost
 * billed so far, even when `converse` throws something other than
 * `MaxIterationsReachedError` (which already carries its own explicit
 * values) partway through a multi-iteration turn. Without this, that branch
 * previously hardcoded `iterations: 1, totalCostUsd: 0` — correct only for a
 * failure on the very first call, and an under-report for any later one.
 * `iterations` is set to the in-flight iteration number just before each
 * `llmProvider.complete()` call, so a failure inside that call still counts
 * as an attempted iteration; `totalCostUsd` only grows after a call
 * actually succeeds and bills.
 */
interface TurnProgress {
  totalCostUsd: number;
  iterations: number;
}

/**
 * `record()` is contracted to never throw (see `@hermes/telemetry`'s
 * README) — this guards a misbehaving third-party `TelemetryRecorder` from
 * ever affecting a turn's outcome, mirroring `packages/llm`'s adapter.
 */
function emitTelemetryEvent(recorder: TelemetryRecorder | undefined, event: TelemetryEvent): void {
  try {
    recorder?.record(event);
  } catch {
    // Swallowed by design — see the function comment above.
  }
}

function assertLlmCallAllowed(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LlmAbortedError("agent turn aborted before an LLM call was attempted");
  }
}

function assertToolInvocationAllowed(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LlmAbortedError("agent turn aborted before a tool handler was invoked");
  }
}

function truncateToolError(message: string): string {
  return message.length > TOOL_ERROR_MAX_CHARS ? message.slice(0, TOOL_ERROR_MAX_CHARS) : message;
}

/** Distinguishes "the timeout race won" from a handler resolving with this exact value. */
const TOOL_TIMEOUT = Symbol("tool-handler-timeout");

/**
 * Runs one validated tool call inside a race against `TOOL_HANDLER_TIMEOUT_MS`
 * (`delay`, reused from `@hermes/core`) — a handler that never returns
 * produces a timeout result instead of stalling the turn. A handler that
 * throws never aborts the turn either: its message becomes the tool result
 * (settled decision 15).
 *
 * The race's `delay` is driven by `raceSignal` — `signal` composed
 * (`AbortSignal.any`, same composition `packages/llm`'s adapter uses) with a
 * `handlerWon` controller this function owns — for two reasons: (1) when the
 * handler wins the race, the `finally` below aborts `handlerWon`, which
 * cancels `delay`'s still-pending timer immediately instead of leaking it
 * for up to `TOOL_HANDLER_TIMEOUT_MS`; (2) when `signal` itself fires
 * (shutdown) before the handler resolves, the same early-resolve path is
 * taken, so `outcome === TOOL_TIMEOUT` is ambiguous between "really timed
 * out" and "shut down mid-handler" — resolved below by checking `signal`
 * itself, not the race outcome.
 */
async function invokeTool(
  spec: ToolSpec,
  args: unknown,
  signal: AbortSignal,
): Promise<{ content: string; error?: string }> {
  const handlerWon = new AbortController();
  const raceSignal = AbortSignal.any([signal, handlerWon.signal]);
  try {
    const outcome = await Promise.race([
      spec.handler(args, { signal }),
      delay(TOOL_HANDLER_TIMEOUT_MS, raceSignal).then(() => TOOL_TIMEOUT),
    ]);

    if (outcome === TOOL_TIMEOUT) {
      const message = signal.aborted
        ? "tool aborted: agent turn was shut down before the handler finished"
        : `tool timed out after ${TOOL_HANDLER_TIMEOUT_MS}ms`;
      return { content: message, error: message };
    }
    return { content: typeof outcome === "string" ? outcome : JSON.stringify(outcome) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: message, error: message };
  } finally {
    handlerWon.abort();
  }
}

/**
 * Emits this call's `tool.call` telemetry event and turns the outcome into
 * the `role: "tool"` message fed back to the model. `approved` defaults to
 * `true` for the ungated path (`resolveToolCall`, below) — `runGatedToolCalls`
 * passes `false` explicitly for a denied/timed-out/aborted gated call.
 */
function finishToolCall(
  toolCall: ToolCall,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
  startedAt: number,
  outcome: { content: string; error?: string },
  approved = true,
): Message {
  emitTelemetryEvent(deps.telemetryRecorder, {
    name: "tool.call",
    threadId,
    turnId,
    tool: toolCall.name,
    durationMs: Date.now() - startedAt,
    approved,
    ...(outcome.error !== undefined ? { error: truncateToolError(outcome.error) } : {}),
  });
  return { role: "tool", content: outcome.content, toolCallId: toolCall.id };
}

/**
 * Resolves one `ToolCall` into a tool-result `Message`: an unknown tool name
 * or a `safeParse` failure both feed back a message and never invoke a
 * handler (settled decision 15's error-recovery shape, applied uniformly).
 * The per-tool-call retry counter (`retryCounts`, keyed by tool name, scoped
 * to this turn) gives a validation failure exactly one corrective
 * round-trip: the first failure's result is the raw zod error, the second
 * (and every one after) is the terminal "invalid arguments, giving up"
 * message — the count is never decremented by an intervening success.
 */
async function resolveToolCall(
  toolCall: ToolCall,
  toolsByName: Map<string, ToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
): Promise<Message> {
  const startedAt = Date.now();
  const spec = toolsByName.get(toolCall.name);

  if (!spec) {
    const content = `unknown tool: ${toolCall.name}`;
    return finishToolCall(toolCall, deps, threadId, turnId, startedAt, { content, error: content });
  }

  const parsed = spec.schema.safeParse(toolCall.arguments);
  if (!parsed.success) {
    const attempt = (retryCounts.get(spec.name) ?? 0) + 1;
    retryCounts.set(spec.name, attempt);
    const zodMessage = parsed.error.message;
    const content = attempt >= 2 ? `invalid arguments, giving up: ${zodMessage}` : zodMessage;
    return finishToolCall(toolCall, deps, threadId, turnId, startedAt, { content, error: content });
  }

  // Dispatched via `.map()`/`Promise.all` below — every call's synchronous
  // work (map lookup, `safeParse`, this check) runs before its first
  // `await`, so there is no event-loop gap between calls for an abort to
  // land "between" them. One pre-invocation check per call is sufficient.
  assertToolInvocationAllowed(deps.signal);

  const outcome = await invokeTool(spec, parsed.data, deps.signal);
  return finishToolCall(toolCall, deps, threadId, turnId, startedAt, outcome);
}

/** All tool calls in one model response execute concurrently, never sequentially. */
function runToolCalls(
  toolCalls: ToolCall[],
  toolsByName: Map<string, ToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
): Promise<Message[]> {
  return Promise.all(
    toolCalls.map((toolCall) =>
      resolveToolCall(toolCall, toolsByName, retryCounts, deps, threadId, turnId),
    ),
  );
}

/**
 * Resolves a batch of gated tool calls behind one combined approval prompt
 * (settled decision 5 — one prompt for the whole batch, not one per call).
 * Denied, timed out, or aborted mid-wait are the same code path (settled
 * decision 7): every call in the batch becomes an `APPROVAL_DENIED_MESSAGE`
 * tool result, no handler ever runs, and the turn's retry counter is never
 * touched. An approved batch falls through to the exact same
 * validate-then-invoke path an ungated call takes (`runToolCalls`) —
 * approval only gates *whether* a call runs, never how its args are
 * validated or retried.
 */
async function runGatedToolCalls(
  gatedCalls: ToolCall[],
  toolsByName: Map<string, ToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string,
  turnId: string,
): Promise<Message[]> {
  const { approvalGate } = deps;
  if (!approvalGate) {
    // assertApprovalGateConfigured (called at construction, in createAgent)
    // guarantees a gate exists whenever a gated tool is configured, so this
    // only fires if that invariant was somehow bypassed.
    throw new Error("runGatedToolCalls invoked without an approvalGate configured");
  }
  // Mirrors the ungated path's per-call check in `resolveToolCall`: an
  // already-aborted turn must not send an approval prompt during shutdown.
  assertToolInvocationAllowed(deps.signal);
  const startedAt = Date.now();
  const batch: ApprovalRequest[] = gatedCalls.map((call) => ({
    tool: call.name,
    args: call.arguments,
  }));
  const decision = await approvalGate.requestApproval(batch, { threadId, turnId }, deps.signal);

  if (decision === "approved") {
    return runToolCalls(gatedCalls, toolsByName, retryCounts, deps, threadId, turnId);
  }

  return gatedCalls.map((toolCall) =>
    finishToolCall(
      toolCall,
      deps,
      threadId,
      turnId,
      startedAt,
      { content: APPROVAL_DENIED_MESSAGE },
      false,
    ),
  );
}

/**
 * Splits one response's tool calls into gated (`requiresApproval: true`) and
 * ungated, and dispatches both concurrently: the approval wait for any
 * gated calls never blocks the ungated calls' execution (settled decision
 * 16). An unknown tool name (no matching `ToolSpec`) is never gated — it
 * falls through to the existing "unknown tool" ungated path unchanged.
 * Results are recombined in the model's original call order before being
 * appended to the conversation.
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  toolsByName: Map<string, ToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string,
  turnId: string,
): Promise<Message[]> {
  const gatedIds = new Set(
    toolCalls.filter((call) => toolsByName.get(call.name)?.requiresApproval).map((call) => call.id),
  );
  const gatedCalls = toolCalls.filter((call) => gatedIds.has(call.id));
  const ungatedCalls = toolCalls.filter((call) => !gatedIds.has(call.id));

  const [ungatedResults, gatedResults] = await Promise.all([
    runToolCalls(ungatedCalls, toolsByName, retryCounts, deps, threadId, turnId),
    gatedCalls.length > 0
      ? runGatedToolCalls(gatedCalls, toolsByName, retryCounts, deps, threadId, turnId)
      : Promise.resolve<Message[]>([]),
  ]);

  const byCallId = new Map(
    [...ungatedResults, ...gatedResults].map(
      (message) => [(message as { toolCallId: string }).toolCallId, message] as const,
    ),
  );
  return toolCalls.map((call) => {
    const message = byCallId.get(call.id);
    if (!message) {
      throw new Error(`no tool result produced for call "${call.id}" (${call.name})`);
    }
    return message;
  });
}

/**
 * The tool-execution loop: assembles the byte-stable prefix once, trims
 * stored history once, then calls the model up to `MAX_ITERATIONS` times.
 * The registry (`toolsByName`) and the retry counter (`retryCounts`) are
 * both scoped to this one turn — built fresh every call, never cached
 * across turns. Tool definitions (`toolDefs`) are sent to the provider
 * whenever `definition.tools` is non-empty; `tools` stays `undefined`
 * otherwise.
 */
async function converse(
  definition: AgentDefinition,
  deps: RunTurnDeps,
  thread: Thread,
  turnId: string,
  userText: string,
  progress: TurnProgress,
): Promise<{ text: string; costUsd: number; iterations: number }> {
  const { system, toolDefs } = assemblePrefix(definition);
  const trimmed = trimHistory(thread.messages, HISTORY_BUDGET_CHARS);
  const conversation: Message[] = [...trimmed, { role: "user", content: userText }];
  const toolsByName = new Map(definition.tools.map((tool) => [tool.name, tool]));
  const retryCounts = new Map<string, number>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    assertLlmCallAllowed(deps.signal);
    progress.iterations = iteration;

    const result = await deps.llmProvider.complete({
      model: definition.model,
      system,
      messages: conversation,
      tools: definition.tools.length > 0 ? toolDefs : undefined,
      maxTokens: MAX_TOKENS_PER_TURN,
      threadId: thread.id,
      turnId,
    });
    progress.totalCostUsd += result.costUsd;

    if (result.toolCalls.length === 0) {
      return { text: result.text, costUsd: progress.totalCostUsd, iterations: iteration };
    }

    // The assistant's own tool-call request must precede the tool-result
    // messages answering it — every OpenAI-compatible provider 400s a `role:
    // "tool"` message that isn't preceded by an assistant message carrying
    // the matching `tool_calls` (see `packages/llm`'s adapter serialization).
    conversation.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });

    const toolResultMessages = await executeToolCalls(
      result.toolCalls,
      toolsByName,
      retryCounts,
      deps,
      thread.id,
      turnId,
    );
    conversation.push(...toolResultMessages);
  }

  throw new MaxIterationsReachedError(progress.totalCostUsd, MAX_ITERATIONS);
}

/**
 * Loads the thread, runs the tool-execution loop (`converse`), persists, and
 * replies. Every thrown error emits a `turn` event and rethrows the original
 * error unchanged, so the existing completion handler's generic-failure
 * reply still applies — no new error-handling branch. `UnpricedModelError`
 * gets no special-casing — it takes the same generic `"error"` path as any
 * other provider failure, reporting `iterations`/`totalCostUsd` from the
 * shared `TurnProgress` accumulator (real values as of the failing call, not
 * a hardcoded `1`/`0`). `MaxIterationsReachedError` reports the same kind of
 * real accumulated values, just carried on the error itself rather than
 * `TurnProgress`, as `"max_iterations"`.
 */
export async function runTurn(
  definition: AgentDefinition,
  deps: RunTurnDeps,
  channel: string,
  chatId: string,
  userText: string,
): Promise<string> {
  const turnId = newId();
  const startedAt = Date.now();
  let threadId: string | null = null;
  const progress: TurnProgress = { totalCostUsd: 0, iterations: 0 };

  try {
    const thread = await deps.threadRepo.getOrCreateThread(channel, chatId);
    threadId = thread.id;

    const { text, costUsd, iterations } = await converse(
      definition,
      deps,
      thread,
      turnId,
      userText,
      progress,
    );

    await deps.threadRepo.appendMessages(thread.id, [
      { role: "user", content: userText },
      { role: "assistant", content: text },
    ]);

    emitTelemetryEvent(deps.telemetryRecorder, {
      name: "turn",
      threadId,
      turnId,
      iterations,
      totalCostUsd: costUsd,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
    });
    return text;
  } catch (error) {
    if (error instanceof MaxIterationsReachedError) {
      emitTelemetryEvent(deps.telemetryRecorder, {
        name: "turn",
        threadId,
        turnId,
        iterations: error.iterations,
        totalCostUsd: error.totalCostUsd,
        outcome: "max_iterations",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    emitTelemetryEvent(deps.telemetryRecorder, {
      name: "turn",
      threadId,
      turnId,
      iterations: progress.iterations,
      totalCostUsd: progress.totalCostUsd,
      outcome: error instanceof LlmAbortedError ? "aborted" : "error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
