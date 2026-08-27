import type { Message, TelemetryRecorder, TurnEvent } from "@hermes/core";
import { newId } from "@hermes/core";
import { LlmAbortedError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";
import { HISTORY_BUDGET_CHARS, trimHistory } from "./context-trim";
import { assemblePrefix } from "./prompt";
import type { Thread, ThreadRepo } from "./thread-repo-port";
import type { AgentDefinition } from "./types";

/**
 * Declared here even though this phase's traffic can never reach iteration 2
 * — `tools: undefined` below means `result.toolCalls` is always empty, so
 * the defensive guard in `completeOnce` throws before a second iteration is
 * possible. Phase 2 is the first phase that can actually exercise this cap.
 */
export const MAX_ITERATIONS = 8;

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
 * `record()` is contracted to never throw (see `@hermes/telemetry`'s
 * README) — this guards a misbehaving third-party `TelemetryRecorder` from
 * ever affecting a turn's outcome, mirroring `packages/llm`'s adapter.
 */
function emitTurnEvent(recorder: TelemetryRecorder | undefined, event: TurnEvent): void {
  try {
    recorder?.record(event);
  } catch {
    // Swallowed by design — see the function comment above.
  }
}

/**
 * The single model call this phase's loop makes: assembles the byte-stable
 * prefix, trims stored history to `HISTORY_BUDGET_CHARS`, and appends the
 * new user message *after* trimming so it can never be dropped. Throws a
 * defensive, temporary guard if the model returns a tool call — `tools:
 * undefined` means no provider should ever do that this phase; removed in
 * Phase 2, which adds real handling.
 */
async function completeOnce(
  definition: AgentDefinition,
  deps: RunTurnDeps,
  thread: Thread,
  turnId: string,
  userText: string,
): Promise<{ text: string; costUsd: number }> {
  const { system } = assemblePrefix(definition);
  const trimmed = trimHistory(thread.messages, HISTORY_BUDGET_CHARS);
  const messages: Message[] = [...trimmed, { role: "user", content: userText }];

  const result = await deps.llmProvider.complete({
    model: definition.model,
    system,
    messages,
    tools: undefined,
    maxTokens: MAX_TOKENS_PER_TURN,
    threadId: thread.id,
    turnId,
  });

  if (result.toolCalls.length > 0) {
    throw new Error("tool calls are not supported until packages/agent Phase 2");
  }

  return { text: result.text, costUsd: result.costUsd };
}

/**
 * This phase's loop shape: load thread, trim history, call the model once,
 * persist, reply — no tool loop yet (Phase 2). Every thrown error (an
 * already-aborted signal, a provider failure, or the temporary tool-call
 * guard above) emits a `turn` event with `totalCostUsd: 0` and rethrows the
 * original error unchanged, so the existing completion handler's
 * generic-failure reply still applies. `UnpricedModelError` gets no
 * special-casing — it takes the same generic path as any other provider
 * failure.
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

    if (deps.signal.aborted) {
      throw new LlmAbortedError("agent turn aborted before any LLM call was attempted");
    }

    const { text, costUsd } = await completeOnce(definition, deps, thread, turnId, userText);

    await deps.threadRepo.appendMessages(thread.id, [
      { role: "user", content: userText },
      { role: "assistant", content: text },
    ]);

    emitTurnEvent(deps.telemetryRecorder, {
      name: "turn",
      threadId,
      turnId,
      iterations: 1,
      totalCostUsd: costUsd,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
    });
    return text;
  } catch (error) {
    emitTurnEvent(deps.telemetryRecorder, {
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
