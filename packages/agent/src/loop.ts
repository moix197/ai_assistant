import type { Message, TelemetryEvent, TelemetryRecorder, ToolCall } from "@hermes/core";
import { delay, newId } from "@hermes/core";
import { LlmAbortedError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";
import type { ApprovalGate, ApprovalRequest } from "./approval-gate-port";
import { HISTORY_BUDGET_CHARS, trimHistory } from "./context-trim";
import { assemblePrefix } from "./prompt";
import type { Thread, ThreadRepo } from "./thread-repo-port";
import type { AgentDefinition, AnyToolSpec, ToolContext, ToolPreparation } from "./types";

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
 * `MAX_ITERATIONS`/`HISTORY_BUDGET_CHARS`. The default for every tool that
 * leaves `ToolSpec.timeoutMs` unset; a tool may override it (see
 * `invokeToolHandler`) — a declared `prepare` shares the exact same bound.
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

/** Distinguishes "the timeout race won" from a handler/prepare resolving with this exact value. */
const TOOL_TIMEOUT = Symbol("tool-handler-timeout");

/**
 * Runs `spec.schema.safeParse` against the call's raw arguments and applies
 * the two-strikes retry counter (keyed by tool name, scoped to this turn) —
 * shared by the ungated path (`resolveToolCall`) and the gated path
 * (`prepareGatedCall`), so both count toward the same per-tool-name budget
 * and produce byte-identical content for the same failure.
 */
function parseToolCallArgs(
  toolCall: ToolCall,
  spec: AnyToolSpec,
  retryCounts: Map<string, number>,
): { success: true; data: unknown } | { success: false; content: string } {
  const parsed = spec.schema.safeParse(toolCall.arguments);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const attempt = (retryCounts.get(spec.name) ?? 0) + 1;
  retryCounts.set(spec.name, attempt);
  const zodMessage = parsed.error.message;
  const content = attempt >= 2 ? `invalid arguments, giving up: ${zodMessage}` : zodMessage;
  return { success: false, content };
}

/**
 * Runs one already-validated tool call's handler inside a race against
 * `spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS` (`delay`, reused from
 * `@hermes/core`) — a handler that never returns produces a timeout result
 * instead of stalling the turn. A handler that throws never aborts the turn
 * either: its message becomes the tool result (settled decision 15). Shared
 * by the ungated path (`plan: undefined`) and the approved-gated path
 * (`plan` already resolved by `prepareGatedCall`) — both dispatch through
 * this one function, never two divergent invocation paths.
 *
 * The race's `delay` is driven by `raceSignal` — `ctx.signal` composed
 * (`AbortSignal.any`, same composition `packages/llm`'s adapter uses) with a
 * `handlerWon` controller this function owns — for two reasons: (1) when the
 * handler wins the race, the `finally` below aborts `handlerWon`, which
 * cancels `delay`'s still-pending timer immediately instead of leaking it
 * for up to `TOOL_HANDLER_TIMEOUT_MS`; (2) when `ctx.signal` itself fires
 * (shutdown) before the handler resolves, the same early-resolve path is
 * taken, so `outcome === TOOL_TIMEOUT` is ambiguous between "really timed
 * out" and "shut down mid-handler" — resolved below by checking `ctx.signal`
 * itself, not the race outcome.
 */
async function invokeToolHandler(
  spec: AnyToolSpec,
  args: unknown,
  ctx: ToolContext,
  plan: unknown,
): Promise<{ content: string; error?: string }> {
  const timeoutMs = spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS;
  const handlerWon = new AbortController();
  const raceSignal = AbortSignal.any([ctx.signal, handlerWon.signal]);
  try {
    const outcome = await Promise.race([
      spec.handler(args, { ...ctx, plan }),
      delay(timeoutMs, raceSignal).then(() => TOOL_TIMEOUT),
    ]);

    if (outcome === TOOL_TIMEOUT) {
      const message = ctx.signal.aborted
        ? "tool aborted: agent turn was shut down before the handler finished"
        : `tool timed out after ${timeoutMs}ms`;
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
 * passes `false` explicitly for a denied/refused/timed-out/aborted gated
 * call. `approvalWaitMs` is `undefined` for an ungated call and for a gated
 * call that never reached `requestApproval` (refused during `prepare`);
 * present (possibly `0`) for any call that actually waited on the gate,
 * approved or not — threaded through from `runGatedToolCalls`, never
 * measured here.
 */
function finishToolCall(
  toolCall: ToolCall,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
  startedAt: number,
  outcome: { content: string; error?: string },
  approved = true,
  approvalWaitMs?: number,
): Message {
  emitTelemetryEvent(deps.telemetryRecorder, {
    name: "tool.call",
    threadId,
    turnId,
    tool: toolCall.name,
    durationMs: Date.now() - startedAt,
    approved,
    ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}),
    ...(outcome.error !== undefined ? { error: truncateToolError(outcome.error) } : {}),
  });
  return { role: "tool", content: outcome.content, toolCallId: toolCall.id };
}

/**
 * Resolves one `ToolCall` into a tool-result `Message`: an unknown tool name
 * or a `safeParse` failure both feed back a message and never invoke a
 * handler (settled decision 15's error-recovery shape, applied uniformly).
 *
 * `startedAt` for `durationMs` is captured right before the handler actually
 * runs, not at the top of this function: an unknown tool or a validation
 * failure never invokes a handler at all, and a successful call's clock
 * starts only after lookup/validation, so `durationMs` reflects handler
 * execution time only (settled decision 12a). `approvalWaitMs`, when passed
 * in by `runGatedToolCalls` for a gated-and-approved batch, is threaded
 * through unchanged to every call's `tool.call` event — this function never
 * measures it itself. A prepare-less tool always invokes its handler with
 * `ctx.plan: undefined` — see `ToolSpec<P = void>`'s own doc.
 */
async function resolveToolCall(
  toolCall: ToolCall,
  toolsByName: Map<string, AnyToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
  channel: string,
  channelUserId: string,
  approvalWaitMs?: number,
): Promise<Message> {
  const spec = toolsByName.get(toolCall.name);

  if (!spec) {
    const content = `unknown tool: ${toolCall.name}`;
    return finishToolCall(
      toolCall,
      deps,
      threadId,
      turnId,
      Date.now(),
      { content, error: content },
      true,
      approvalWaitMs,
    );
  }

  const parsed = parseToolCallArgs(toolCall, spec, retryCounts);
  if (!parsed.success) {
    return finishToolCall(
      toolCall,
      deps,
      threadId,
      turnId,
      Date.now(),
      { content: parsed.content, error: parsed.content },
      true,
      approvalWaitMs,
    );
  }

  // Dispatched via `.map()`/`Promise.all` below — every call's synchronous
  // work (map lookup, `safeParse`, this check) runs before its first
  // `await`, so there is no event-loop gap between calls for an abort to
  // land "between" them. One pre-invocation check per call is sufficient.
  assertToolInvocationAllowed(deps.signal);

  const startedAt = Date.now();
  const ctx: ToolContext = { signal: deps.signal, channel, channelUserId, turnId };
  // `prepare` is intentionally never invoked on this ungated path, by design
  // (per `plans/06-legible-approvals-bounded-reads.md`'s Dependencies &
  // Risks) — only the gated path (`prepareGatedCall`) resolves a `plan`
  // before the handler runs. `plan: undefined` is passed unconditionally, a
  // type-lie only for a hypothetical future ungated tool that declares
  // `prepare`; no such tool exists today, so this is not an oversight.
  const outcome = await invokeToolHandler(spec, parsed.data, ctx, undefined);
  return finishToolCall(toolCall, deps, threadId, turnId, startedAt, outcome, true, approvalWaitMs);
}

/**
 * All tool calls in one model response execute concurrently, never
 * sequentially. `approvalWaitMs` is `undefined` for the ungated path — the
 * gated-and-approved path (`runGatedToolCalls`) passes the batch's measured
 * approval wait so every call in it carries the same value.
 */
function runToolCalls(
  toolCalls: ToolCall[],
  toolsByName: Map<string, AnyToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string | null,
  turnId: string,
  channel: string,
  channelUserId: string,
  approvalWaitMs?: number,
): Promise<Message[]> {
  return Promise.all(
    toolCalls.map((toolCall) =>
      resolveToolCall(
        toolCall,
        toolsByName,
        retryCounts,
        deps,
        threadId,
        turnId,
        channel,
        channelUserId,
        approvalWaitMs,
      ),
    ),
  );
}

/**
 * `prepareGatedCall`'s outcome for one gated call. "refused" means the call
 * never reaches the batch and never runs a handler — a validation failure, a
 * `prepare` that throws/times out/aborts, or one that resolves `{ok:false}`
 * are all folded into this one shape. "ready" means the call survived and
 * contributes `batchEntry` to the prompt; `plan`/`parsedArgs` are threaded
 * through, unparsed-`args`-for-display already peeled off, so the eventual
 * approved-handler call never re-parses or re-runs `prepare`.
 */
type GatedCallPreparation =
  | { status: "refused"; toolCall: ToolCall; result: unknown }
  | {
      status: "ready";
      toolCall: ToolCall;
      plan: unknown;
      parsedArgs: unknown;
      batchEntry: ApprovalRequest;
    };

/**
 * Resolves one gated call up to (but not including) the approval prompt:
 * `safeParse`+retry (`parseToolCallArgs`, shared with the ungated path),
 * then `spec.prepare` when declared, raced against the same
 * `spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS` bound `invokeToolHandler` uses.
 * `batchEntry` always carries `toolCall.arguments` — the model's raw,
 * unparsed args — never `parsedArgs`, even though `prepare`/the eventual
 * handler receive the parsed form: this is the one detail most likely to
 * regress silently (see `plans/06-legible-approvals-bounded-reads.md`'s
 * Dependencies & Risks) — a zod-applied default or coercion must never
 * silently change what the human is shown or what `tool.call` logs.
 */
async function prepareGatedCall(
  spec: AnyToolSpec,
  toolCall: ToolCall,
  retryCounts: Map<string, number>,
  ctx: ToolContext,
): Promise<GatedCallPreparation> {
  const parsed = parseToolCallArgs(toolCall, spec, retryCounts);
  if (!parsed.success) {
    return { status: "refused", toolCall, result: parsed.content };
  }
  if (!spec.prepare) {
    return {
      status: "ready",
      toolCall,
      plan: undefined,
      parsedArgs: parsed.data,
      batchEntry: { tool: toolCall.name, args: toolCall.arguments },
    };
  }

  const prepare = spec.prepare;
  const timeoutMs = spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS;
  const handlerWon = new AbortController();
  const raceSignal = AbortSignal.any([ctx.signal, handlerWon.signal]);
  try {
    // Explicitly typed locals, not inlined directly into `Promise.race([...])`
    // — with `spec: AnyToolSpec` (`ToolSpec<any>`), TS's inference otherwise
    // widens the race's resolved type in a way that defeats the
    // `outcome === TOOL_TIMEOUT` narrowing just below (confirmed in
    // isolation: a `P = any` discriminated union raced against a plain
    // symbol needs the arms spelled out, or the equality check no longer
    // excludes the symbol arm).
    // biome-ignore lint/suspicious/noExplicitAny: matches `AnyToolSpec`'s own accepted `any` at this same registry boundary — see its doc in `types.ts`.
    const preparePromise: Promise<ToolPreparation<any>> = prepare(parsed.data, ctx);
    const timeoutPromise: Promise<typeof TOOL_TIMEOUT> = delay(timeoutMs, raceSignal).then(
      () => TOOL_TIMEOUT,
    );
    const outcome = await Promise.race([preparePromise, timeoutPromise]);
    if (outcome === TOOL_TIMEOUT) {
      return { status: "refused", toolCall, result: { ok: false, reason: "prepare_failed" } };
    }
    if (!outcome.ok) {
      return { status: "refused", toolCall, result: outcome.result };
    }
    return {
      status: "ready",
      toolCall,
      plan: outcome.plan,
      parsedArgs: parsed.data,
      batchEntry: {
        tool: toolCall.name,
        args: toolCall.arguments,
        plan: outcome.plan,
        ...(outcome.summary && { summary: outcome.summary }),
      },
    };
  } catch {
    return { status: "refused", toolCall, result: { ok: false, reason: "prepare_failed" } };
  } finally {
    handlerWon.abort();
  }
}

/**
 * Splits `prepareGatedCall`'s per-call outcomes into refusals (no prompt, no
 * handler) and calls that survived `prepare` and are ready to ask about —
 * `batch` is exactly the `ApprovalRequest[]` the survivors contribute, empty
 * when every call in the response was refused (settled decision 11: the
 * caller must skip `requestApproval` entirely in that case, since an
 * empty-batch prompt has nothing left to ask about).
 */
function buildApprovalBatch(preparations: GatedCallPreparation[]): {
  refused: Extract<GatedCallPreparation, { status: "refused" }>[];
  ready: Extract<GatedCallPreparation, { status: "ready" }>[];
  batch: ApprovalRequest[];
} {
  const refused = preparations.filter(
    (p): p is Extract<GatedCallPreparation, { status: "refused" }> => p.status === "refused",
  );
  const ready = preparations.filter(
    (p): p is Extract<GatedCallPreparation, { status: "ready" }> => p.status === "ready",
  );
  return { refused, ready, batch: ready.map((p) => p.batchEntry) };
}

/**
 * Runs every approved call's handler with the `parsedArgs`/`plan`
 * `prepareGatedCall` already resolved — never re-parses and never re-runs
 * `prepare`, since the batch already committed to those exact values when it
 * asked the human. The "declares `prepare` but reached the handler with no
 * `plan`" backstop is defense in depth only: unreachable by construction,
 * since `prepareGatedCall` never returns "ready" for a `prepare`-declaring
 * tool without a resolved `plan`. It resolves *this one call* as the same
 * `prepare_failed` refusal `prepareGatedCall` itself produces for a
 * `prepare` failure (rather than throwing and aborting the whole turn) —
 * code review finding: by the time this backstop can fire, the human has
 * already approved, so throwing here would abort every other call in the
 * same batch over one tool's own defect.
 */
function runReadyGatedCalls(
  ready: Extract<GatedCallPreparation, { status: "ready" }>[],
  toolsByName: Map<string, AnyToolSpec>,
  deps: RunTurnDeps,
  threadId: string,
  turnId: string,
  ctx: ToolContext,
  approvalWaitMs: number,
): Promise<Message[]> {
  return Promise.all(
    ready.map(async (prepared) => {
      const spec = toolsByName.get(prepared.toolCall.name);
      if (!spec) {
        throw new Error(`no ToolSpec found for ready gated call "${prepared.toolCall.name}"`);
      }
      if (spec.prepare && prepared.plan === undefined) {
        const content = JSON.stringify({ ok: false, reason: "prepare_failed" });
        return finishToolCall(
          prepared.toolCall,
          deps,
          threadId,
          turnId,
          Date.now(),
          { content, error: content },
          false,
          approvalWaitMs,
        );
      }
      assertToolInvocationAllowed(deps.signal);
      const startedAt = Date.now();
      const outcome = await invokeToolHandler(spec, prepared.parsedArgs, ctx, prepared.plan);
      return finishToolCall(
        prepared.toolCall,
        deps,
        threadId,
        turnId,
        startedAt,
        outcome,
        true,
        approvalWaitMs,
      );
    }),
  );
}

/**
 * Resolves a batch of gated tool calls: `prepareGatedCall` runs every call's
 * validation+`prepare` step first, `buildApprovalBatch` splits the result
 * into refusals (resolved immediately, `approved:false`, no wait measured)
 * and survivors, then one combined prompt is sent for the survivors only —
 * skipped entirely when none survive (settled decision 11). Denied, timed
 * out, or aborted mid-wait are still one outcome (settled decision 7): every
 * surviving call becomes an `APPROVAL_DENIED_MESSAGE` tool result. An
 * approved batch runs each survivor's handler with its already-resolved
 * `parsedArgs`/`plan` (`runReadyGatedCalls`) — approval only gates *whether*
 * a call runs, never how its arguments were validated or prepared.
 */
async function runGatedToolCalls(
  gatedCalls: ToolCall[],
  toolsByName: Map<string, AnyToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string,
  turnId: string,
  channel: string,
  channelUserId: string,
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

  const ctx: ToolContext = { signal: deps.signal, channel, channelUserId, turnId };
  const preparations = await Promise.all(
    gatedCalls.map((call) => {
      const spec = toolsByName.get(call.name);
      if (!spec) {
        throw new Error(
          `no ToolSpec found for gated call "${call.name}" — executeToolCalls only ever gates a call with a known, requiresApproval spec`,
        );
      }
      return prepareGatedCall(spec, call, retryCounts, ctx);
    }),
  );
  // A second check, mirroring the one above: a mixed batch can have one
  // call's `prepare` resolve near-instantly (or skip it entirely, having no
  // `prepare` declared) while a sibling call's `prepare` is still racing the
  // abort signal — the pre-`prepare` check alone does not cover an abort
  // that lands in that window, after every call's preparation has settled
  // but before the survivors' prompt is built and sent (finding 4 of the
  // Phase 3 review).
  assertToolInvocationAllowed(deps.signal);
  const { refused, ready, batch } = buildApprovalBatch(preparations);
  const refusedResults = refused.map((p) => {
    // Mirrors `resolveToolCall`'s validation-failure branch and
    // `invokeToolHandler`'s failure branches: `content` and `error` carry
    // the identical diagnostic string, never just `content` alone — a
    // gated validation failure refused during `prepareGatedCall` must keep
    // the same `tool.call` telemetry detail a pre-`prepare` validation
    // failure always carried (finding 3 of the Phase 3 review).
    const content = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
    return finishToolCall(
      p.toolCall,
      deps,
      threadId,
      turnId,
      Date.now(),
      { content, error: content },
      false,
    );
  });

  if (ready.length === 0) {
    return refusedResults;
  }

  const waitStartedAt = Date.now();
  const decision = await approvalGate.requestApproval(batch, { threadId, turnId }, deps.signal);
  const approvalWaitMs = Date.now() - waitStartedAt;

  if (decision === "approved") {
    const approvedResults = await runReadyGatedCalls(
      ready,
      toolsByName,
      deps,
      threadId,
      turnId,
      ctx,
      approvalWaitMs,
    );
    return [...refusedResults, ...approvedResults];
  }

  const resolvedAt = Date.now();
  const deniedResults = ready.map((p) =>
    finishToolCall(
      p.toolCall,
      deps,
      threadId,
      turnId,
      resolvedAt,
      { content: APPROVAL_DENIED_MESSAGE },
      false,
      approvalWaitMs,
    ),
  );
  return [...refusedResults, ...deniedResults];
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
  toolsByName: Map<string, AnyToolSpec>,
  retryCounts: Map<string, number>,
  deps: RunTurnDeps,
  threadId: string,
  turnId: string,
  channel: string,
  channelUserId: string,
): Promise<Message[]> {
  const gatedIds = new Set(
    toolCalls.filter((call) => toolsByName.get(call.name)?.requiresApproval).map((call) => call.id),
  );
  const gatedCalls = toolCalls.filter((call) => gatedIds.has(call.id));
  const ungatedCalls = toolCalls.filter((call) => !gatedIds.has(call.id));

  const [ungatedResults, gatedResults] = await Promise.all([
    runToolCalls(
      ungatedCalls,
      toolsByName,
      retryCounts,
      deps,
      threadId,
      turnId,
      channel,
      channelUserId,
    ),
    gatedCalls.length > 0
      ? runGatedToolCalls(
          gatedCalls,
          toolsByName,
          retryCounts,
          deps,
          threadId,
          turnId,
          channel,
          channelUserId,
        )
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
 *
 * `newMessages` in the return value is the tail of `conversation` this turn
 * actually produced — the seed user message plus every assistant/tool
 * message generated by the loop, in wire order, ending with the final
 * assistant reply — sliced directly off the one local array the loop already
 * builds and appends to, rather than reconstructed from `text`/`toolCalls`
 * separately. `runTurn` persists this unchanged, so there is exactly one
 * source of truth for what a turn produced.
 */
async function converse(
  definition: AgentDefinition,
  deps: RunTurnDeps,
  thread: Thread,
  turnId: string,
  channelUserId: string,
  userText: string,
  progress: TurnProgress,
): Promise<{ text: string; newMessages: Message[]; costUsd: number; iterations: number }> {
  const { system, toolDefs } = assemblePrefix(definition);
  const trimmed = trimHistory(thread.messages, HISTORY_BUDGET_CHARS);
  const conversation: Message[] = [...trimmed, { role: "user", content: userText }];
  const newMessagesStart = trimmed.length;
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
      // Appends onto a fresh array, not `conversation` itself: `conversation`
      // was just handed to `deps.llmProvider.complete()` as `request.messages`
      // by reference (never cloned) — mutating it further here, after that
      // call already returned, would be a footgun for any caller (a test's
      // mock included) still holding that same reference.
      const finalMessage: Message = { role: "assistant", content: result.text };
      return {
        text: result.text,
        newMessages: [...conversation.slice(newMessagesStart), finalMessage],
        costUsd: progress.totalCostUsd,
        iterations: iteration,
      };
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
      thread.channel,
      channelUserId,
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
  channelUserId: string,
  userText: string,
): Promise<string> {
  const turnId = newId();
  const startedAt = Date.now();
  let threadId: string | null = null;
  const progress: TurnProgress = { totalCostUsd: 0, iterations: 0 };

  try {
    const thread = await deps.threadRepo.getOrCreateThread(channel, chatId);
    threadId = thread.id;

    const { text, newMessages, costUsd, iterations } = await converse(
      definition,
      deps,
      thread,
      turnId,
      channelUserId,
      userText,
      progress,
    );

    await deps.threadRepo.appendMessages(thread.id, newMessages);

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
