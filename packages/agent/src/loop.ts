import type { Message, TelemetryEvent, TelemetryRecorder, ToolCall } from "@hermes/core";
import { delay, newId } from "@hermes/core";
import { LlmAbortedError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";
import { HISTORY_BUDGET_CHARS, trimHistory } from "./context-trim";
import { assemblePrefix } from "./prompt";
import type { Thread, ThreadRepo } from "./thread-repo-port";
import type { AgentDefinition, ToolSpec } from "./types";

/**
 * Bounds the whole turn's model round-trips. Declared even in Phase 1, when
 * traffic could never reach iteration 2 (no tools meant `toolCalls` was
 * always empty) — Phase 2 is the first phase that can actually exercise it,
 * via the tool loop below.
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
}

/**
 * Thrown internally when the loop exhausts `MAX_ITERATIONS` without a final
 * text response. Carries the real accumulated cost/iteration count so the
 * `turn` event reflects the paid calls that actually happened, unlike the
 * generic `"error"`/`"aborted"` paths below (which never partially
 * accumulate cost — see the Dependencies & Risks note on `UnpricedModelError`
 * taking the same zero-cost generic path as any other provider throw).
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
 */
async function invokeTool(
  spec: ToolSpec,
  args: unknown,
  signal: AbortSignal,
): Promise<{ content: string; error?: string }> {
  try {
    const outcome = await Promise.race([
      spec.handler(args, { signal }),
      delay(TOOL_HANDLER_TIMEOUT_MS, signal).then(() => TOOL_TIMEOUT),
    ]);

    if (outcome === TOOL_TIMEOUT) {
      const message = `tool timed out after ${TOOL_HANDLER_TIMEOUT_MS}ms`;
      return { content: message, error: message };
    }
    return { content: typeof outcome === "string" ? outcome : JSON.stringify(outcome) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: message, error: message };
  }
}

/**
 * Emits this call's `tool.call` telemetry event and turns the outcome into
 * the `role: "tool"` message fed back to the model. `approved: true`
 * unconditionally this phase — no approval gate exists yet (Phase 3).
 */
function finishToolCall(
  toolCall: ToolCall,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
  startedAt: number,
  outcome: { content: string; error?: string },
): Message {
  emitTelemetryEvent(deps.telemetryRecorder, {
    name: "tool.call",
    threadId,
    turnId,
    tool: toolCall.name,
    durationMs: Date.now() - startedAt,
    approved: true,
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
 * The tool-execution loop: assembles the byte-stable prefix once, trims
 * stored history once, then calls the model up to `MAX_ITERATIONS` times.
 * The registry (`toolsByName`) and the retry counter (`retryCounts`) are
 * both scoped to this one turn — built fresh every call, never cached
 * across turns. Real tool definitions (`toolDefs`) are sent to the provider
 * for the first time this phase; `tools` stays `undefined` when
 * `definition.tools` is empty, exactly as Phase 1 shipped it.
 */
async function converse(
  definition: AgentDefinition,
  deps: RunTurnDeps,
  thread: Thread,
  turnId: string,
  userText: string,
): Promise<{ text: string; costUsd: number; iterations: number }> {
  const { system, toolDefs } = assemblePrefix(definition);
  const trimmed = trimHistory(thread.messages, HISTORY_BUDGET_CHARS);
  const conversation: Message[] = [...trimmed, { role: "user", content: userText }];
  const toolsByName = new Map(definition.tools.map((tool) => [tool.name, tool]));
  const retryCounts = new Map<string, number>();
  let totalCostUsd = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    assertLlmCallAllowed(deps.signal);

    const result = await deps.llmProvider.complete({
      model: definition.model,
      system,
      messages: conversation,
      tools: definition.tools.length > 0 ? toolDefs : undefined,
      maxTokens: MAX_TOKENS_PER_TURN,
      threadId: thread.id,
      turnId,
    });
    totalCostUsd += result.costUsd;

    if (result.toolCalls.length === 0) {
      return { text: result.text, costUsd: totalCostUsd, iterations: iteration };
    }

    const toolResultMessages = await runToolCalls(
      result.toolCalls,
      toolsByName,
      retryCounts,
      deps,
      thread.id,
      turnId,
    );
    conversation.push(...toolResultMessages);
  }

  throw new MaxIterationsReachedError(totalCostUsd, MAX_ITERATIONS);
}

/**
 * Loads the thread, runs the tool-execution loop (`converse`), persists, and
 * replies. Every thrown error emits a `turn` event and rethrows the original
 * error unchanged, so the existing completion handler's generic-failure
 * reply still applies — no new error-handling branch. `UnpricedModelError`
 * gets no special-casing — it takes the same generic `"error"` path as any
 * other provider failure, `totalCostUsd: 0`. `MaxIterationsReachedError` is
 * the one exception: it carries the real accumulated cost and iteration
 * count from the calls that actually happened, reported as `"max_iterations"`.
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

  try {
    const thread = await deps.threadRepo.getOrCreateThread(channel, chatId);
    threadId = thread.id;

    const { text, costUsd, iterations } = await converse(definition, deps, thread, turnId, userText);

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
      iterations: 1,
      totalCostUsd: 0,
      outcome: error instanceof LlmAbortedError ? "aborted" : "error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
