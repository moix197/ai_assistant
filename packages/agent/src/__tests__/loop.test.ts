import type { Message, TelemetryEvent, TelemetryRecorder } from "@hermes/core";
import {
  type CompletionRequest,
  type CompletionResult,
  LlmAbortedError,
  type LlmProvider,
} from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_BUDGET_CHARS } from "../context-trim";
import { runTurn } from "../loop";
import type { Thread, ThreadRepo } from "../thread-repo-port";
import type { AgentDefinition } from "../types";

function definition(): AgentDefinition {
  return {
    name: "hermes",
    model: "deepseek-v4-flash",
    systemPrompt: "You are Hermes, a helpful assistant.",
    tools: [],
    channels: ["telegram"],
  };
}

function fakeThread(overrides: Partial<Thread> = {}): Thread {
  return { id: "thread-1", channel: "telegram", chatId: "555", messages: [], ...overrides };
}

function fakeThreadRepo(thread: Thread = fakeThread()): ThreadRepo & {
  getOrCreateThread: ReturnType<typeof vi.fn>;
  appendMessages: ReturnType<typeof vi.fn>;
} {
  return {
    getOrCreateThread: vi.fn().mockResolvedValue(thread),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeRecorder(): TelemetryRecorder & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn() };
}

function completionResult(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return {
    text: "a reply",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheHitTokens: 0 },
    finishReason: "stop",
    costUsd: 0.001,
    ...overrides,
  };
}

function recordedTurnEvent(recorder: { record: ReturnType<typeof vi.fn> }): TelemetryEvent {
  const call = recorder.record.mock.calls.find(
    ([event]) => (event as TelemetryEvent).name === "turn",
  );
  if (!call) throw new Error("no turn event was recorded");
  return call[0] as TelemetryEvent;
}

describe("runTurn — happy path", () => {
  it("calls the provider once, persists user+assistant messages together, and emits a completed turn event", async () => {
    const llmProvider: LlmProvider = { complete: vi.fn().mockResolvedValue(completionResult()) };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();

    const text = await runTurn(
      definition(),
      {
        llmProvider,
        threadRepo,
        telemetryRecorder: recorder,
        signal: new AbortController().signal,
      },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("a reply");
    expect(threadRepo.appendMessages).toHaveBeenCalledTimes(1);
    expect(threadRepo.appendMessages).toHaveBeenCalledWith("thread-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "a reply" },
    ] satisfies Message[]);

    const event = recordedTurnEvent(recorder);
    expect(event).toMatchObject({
      name: "turn",
      threadId: "thread-1",
      iterations: 1,
      totalCostUsd: 0.001,
      outcome: "completed",
    });
    expect((event as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stamps the request with the thread's real threadId and a freshly generated turnId", async () => {
    const complete = vi.fn().mockResolvedValue(completionResult());
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    await runTurn(
      definition(),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    const request = complete.mock.calls[0]?.[0] as CompletionRequest;
    expect(request.threadId).toBe("thread-1");
    expect(typeof request.turnId).toBe("string");
    expect(request.turnId).not.toBe("");
    expect(request.tools).toBeUndefined();
  });

  it("sends the trimmed stored history followed by the new user message, and nothing else", async () => {
    // One message over the whole budget on its own, so trimming must drop it.
    const overBudget: Message = {
      role: "user",
      content: "x".repeat(HISTORY_BUDGET_CHARS * 4 + 4),
    };
    const kept: Message[] = [
      { role: "assistant", content: "an earlier reply" },
      { role: "user", content: "the message before this one" },
    ];
    const complete = vi.fn().mockResolvedValue(completionResult());
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo(fakeThread({ messages: [overBudget, ...kept] }));

    await runTurn(
      definition(),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    const request = complete.mock.calls[0]?.[0] as CompletionRequest;
    expect(request.messages).toEqual([
      ...kept,
      { role: "user", content: "hello" },
    ] satisfies Message[]);
  });
});

describe("runTurn — abort", () => {
  it("throws LlmAbortedError before the provider is ever called when the signal is already aborted, and emits an aborted turn event", async () => {
    const complete = vi.fn();
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTurn(
        definition(),
        { llmProvider, threadRepo, telemetryRecorder: recorder, signal: controller.signal },
        "telegram",
        "555",
        "hello",
      ),
    ).rejects.toBeInstanceOf(LlmAbortedError);

    expect(complete).not.toHaveBeenCalled();
    expect(threadRepo.appendMessages).not.toHaveBeenCalled();

    const event = recordedTurnEvent(recorder);
    expect(event).toMatchObject({
      name: "turn",
      threadId: "thread-1",
      outcome: "aborted",
      totalCostUsd: 0,
    });
  });
});

describe("runTurn — provider failure", () => {
  it("rethrows the original error unchanged and emits an error turn event", async () => {
    const failure = new Error("provider exploded");
    const llmProvider: LlmProvider = { complete: vi.fn().mockRejectedValue(failure) };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();

    await expect(
      runTurn(
        definition(),
        {
          llmProvider,
          threadRepo,
          telemetryRecorder: recorder,
          signal: new AbortController().signal,
        },
        "telegram",
        "555",
        "hello",
      ),
    ).rejects.toBe(failure);

    expect(threadRepo.appendMessages).not.toHaveBeenCalled();

    const event = recordedTurnEvent(recorder);
    expect(event).toMatchObject({ name: "turn", outcome: "error", totalCostUsd: 0 });
  });
});

describe("runTurn — Phase 1 tool-call guard", () => {
  it("throws when the provider returns a non-empty toolCalls, proving the temporary guard is reachable", async () => {
    const llmProvider: LlmProvider = {
      complete: vi
        .fn()
        .mockResolvedValue(
          completionResult({ toolCalls: [{ id: "call_1", name: "noop", arguments: {} }] }),
        ),
    };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();

    await expect(
      runTurn(
        definition(),
        {
          llmProvider,
          threadRepo,
          telemetryRecorder: recorder,
          signal: new AbortController().signal,
        },
        "telegram",
        "555",
        "hello",
      ),
    ).rejects.toThrow(/tool calls are not supported until packages\/agent Phase 2/);

    expect(threadRepo.appendMessages).not.toHaveBeenCalled();
    const event = recordedTurnEvent(recorder);
    expect(event).toMatchObject({ name: "turn", outcome: "error" });
  });
});
