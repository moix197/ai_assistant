import type { Message, TelemetryEvent, TelemetryRecorder } from "@hermes/core";
import {
  type CompletionRequest,
  type CompletionResult,
  LlmAbortedError,
  type LlmProvider,
} from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { HISTORY_BUDGET_CHARS } from "../context-trim";
import { runTurn } from "../loop";
import type { Thread, ThreadRepo } from "../thread-repo-port";
import type { AgentDefinition, ToolSpec } from "../types";

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "hermes",
    model: "deepseek-v4-flash",
    systemPrompt: "You are Hermes, a helpful assistant.",
    tools: [],
    channels: ["telegram"],
    ...overrides,
  };
}

function tool(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: "noop",
    description: "does nothing",
    schema: z.object({}),
    handler: async () => "done",
    requiresApproval: false,
    ...overrides,
  };
}

function findToolMessage(request: CompletionRequest, toolCallId: string): Message | undefined {
  return request.messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
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

describe("runTurn — tool execution", () => {
  it("invokes a registered tool, appends its result, and completes on the following response's text", async () => {
    const handler = vi.fn().mockResolvedValue("tool output");
    const noopTool = tool({ handler });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [{ id: "call_1", name: "noop", arguments: {} }],
          text: "",
        }),
      )
      .mockResolvedValueOnce(completionResult({ text: "final answer" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    const text = await runTurn(
      definition({ tools: [noopTool] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("final answer");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(threadRepo.appendMessages).toHaveBeenCalledWith("thread-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "final answer" },
    ]);

    const secondRequest = complete.mock.calls[1]?.[0] as CompletionRequest;
    expect(findToolMessage(secondRequest, "call_1")?.content).toBe("tool output");
  });

  it("passes real tool definitions to the provider once definition.tools is non-empty", async () => {
    const complete = vi.fn().mockResolvedValue(completionResult());
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    await runTurn(
      definition({ tools: [tool({ name: "get_current_time" })] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    const request = complete.mock.calls[0]?.[0] as CompletionRequest;
    expect(request.tools).toEqual([
      expect.objectContaining({ name: "get_current_time" }),
    ]);
  });

  it("feeds back an 'unknown tool' result and continues when the model calls an unregistered tool", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [{ id: "call_1", name: "mystery", arguments: {} }],
          text: "",
        }),
      )
      .mockResolvedValueOnce(completionResult({ text: "ok" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    const text = await runTurn(
      definition(),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("ok");
    const secondRequest = complete.mock.calls[1]?.[0] as CompletionRequest;
    expect(findToolMessage(secondRequest, "call_1")?.content).toContain("unknown tool");
  });

  it("feeds back a thrown handler's message as the tool result and continues the turn", async () => {
    const failure = new Error("handler blew up");
    const boomTool = tool({ name: "boom", handler: vi.fn().mockRejectedValue(failure) });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({ toolCalls: [{ id: "call_1", name: "boom", arguments: {} }], text: "" }),
      )
      .mockResolvedValueOnce(completionResult({ text: "recovered" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    const text = await runTurn(
      definition({ tools: [boomTool] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("recovered");
    const secondRequest = complete.mock.calls[1]?.[0] as CompletionRequest;
    expect(findToolMessage(secondRequest, "call_1")?.content).toBe("handler blew up");
  });

  it("gives a tool exactly one corrective round-trip on repeated validation failures, then a terminal message, while continuing the turn", async () => {
    const schema = z.object({ value: z.string() });
    const handler = vi.fn().mockResolvedValue("ok");
    const needsArgTool = tool({ name: "needs_arg", schema, handler });
    const badArgs = { value: 123 };
    const parseFailure = schema.safeParse(badArgs);
    if (parseFailure.success) throw new Error("fixture bug: badArgs must fail validation");
    const expectedZodMessage = parseFailure.error.message;

    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [{ id: "c1", name: "needs_arg", arguments: badArgs }],
          text: "",
        }),
      )
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [{ id: "c2", name: "needs_arg", arguments: badArgs }],
          text: "",
        }),
      )
      .mockResolvedValueOnce(completionResult({ text: "done" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    const text = await runTurn(
      definition({ tools: [needsArgTool] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("done");
    expect(handler).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(3);

    const finalRequest = complete.mock.calls[2]?.[0] as CompletionRequest;
    expect(findToolMessage(finalRequest, "c1")?.content).toBe(expectedZodMessage);
    expect(findToolMessage(finalRequest, "c2")?.content).toBe(
      `invalid arguments, giving up: ${expectedZodMessage}`,
    );
  });

  it("keys the two-strikes retry counter per tool name, not globally", async () => {
    const schemaA = z.object({ value: z.string() });
    const schemaB = z.object({ other: z.string() });
    const toolA = tool({ name: "tool_a", schema: schemaA, handler: vi.fn() });
    const toolB = tool({ name: "tool_b", schema: schemaB, handler: vi.fn() });
    const badA = { value: 1 };
    const badB = { other: 2 };
    const failureA = schemaA.safeParse(badA);
    const failureB = schemaB.safeParse(badB);
    if (failureA.success || failureB.success) throw new Error("fixture bug: args must fail validation");
    const expectedA = failureA.error.message;
    const expectedB = failureB.error.message;

    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({ toolCalls: [{ id: "a1", name: "tool_a", arguments: badA }], text: "" }),
      )
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [
            { id: "a2", name: "tool_a", arguments: badA },
            { id: "b1", name: "tool_b", arguments: badB },
          ],
          text: "",
        }),
      )
      .mockResolvedValueOnce(completionResult({ text: "done" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    await runTurn(
      definition({ tools: [toolA, toolB] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    const finalRequest = complete.mock.calls[2]?.[0] as CompletionRequest;
    expect(findToolMessage(finalRequest, "a2")?.content).toBe(
      `invalid arguments, giving up: ${expectedA}`,
    );
    expect(findToolMessage(finalRequest, "b1")?.content).toBe(expectedB);
  });

  it("times out a hanging handler while an unaffected sibling call in the same batch still completes", async () => {
    vi.useFakeTimers();
    try {
      const hangingHandler = vi.fn(() => new Promise<never>(() => {}));
      const okHandler = vi.fn().mockResolvedValue("sibling ok");
      const hangingTool = tool({ name: "hangs", handler: hangingHandler });
      const okTool = tool({ name: "fine", handler: okHandler });

      const complete = vi
        .fn()
        .mockResolvedValueOnce(
          completionResult({
            toolCalls: [
              { id: "c1", name: "hangs", arguments: {} },
              { id: "c2", name: "fine", arguments: {} },
            ],
            text: "",
          }),
        )
        .mockResolvedValueOnce(completionResult({ text: "done" }));
      const llmProvider: LlmProvider = { complete };
      const threadRepo = fakeThreadRepo();

      const resultPromise = runTurn(
        definition({ tools: [hangingTool, okTool] }),
        { llmProvider, threadRepo, signal: new AbortController().signal },
        "telegram",
        "555",
        "hello",
      );

      await vi.runAllTimersAsync();
      const text = await resultPromise;

      expect(text).toBe("done");
      const secondRequest = complete.mock.calls[1]?.[0] as CompletionRequest;
      expect(findToolMessage(secondRequest, "c1")?.content).toContain("tool timed out");
      expect(findToolMessage(secondRequest, "c2")?.content).toBe("sibling ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes multiple tool calls in one response concurrently, not sequentially", async () => {
    let resolveAStarted!: () => void;
    let resolveBStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      resolveAStarted = resolve;
    });
    const bStarted = new Promise<void>((resolve) => {
      resolveBStarted = resolve;
    });

    // Each handler waits for the *other* to have started. This only
    // resolves if both are dispatched before either awaits — i.e. genuinely
    // concurrently. A sequential implementation (await one fully before
    // starting the next) deadlocks here and the test times out.
    const handlerA = vi.fn(async () => {
      resolveAStarted();
      await bStarted;
      return "a-done";
    });
    const handlerB = vi.fn(async () => {
      resolveBStarted();
      await aStarted;
      return "b-done";
    });

    const toolA = tool({ name: "tool_a", handler: handlerA });
    const toolB = tool({ name: "tool_b", handler: handlerB });

    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({
          toolCalls: [
            { id: "a1", name: "tool_a", arguments: {} },
            { id: "b1", name: "tool_b", arguments: {} },
          ],
          text: "",
        }),
      )
      .mockResolvedValueOnce(completionResult({ text: "done" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();

    const text = await runTurn(
      definition({ tools: [toolA, toolB] }),
      { llmProvider, threadRepo, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    expect(text).toBe("done");
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("emits its own truncated tool.call telemetry event per call, approved: true unconditionally", async () => {
    const longError = "x".repeat(600);
    const boomTool = tool({ name: "boom", handler: vi.fn().mockRejectedValue(new Error(longError)) });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        completionResult({ toolCalls: [{ id: "call_1", name: "boom", arguments: {} }], text: "" }),
      )
      .mockResolvedValueOnce(completionResult({ text: "ok" }));
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();

    await runTurn(
      definition({ tools: [boomTool] }),
      { llmProvider, threadRepo, telemetryRecorder: recorder, signal: new AbortController().signal },
      "telegram",
      "555",
      "hello",
    );

    const toolCallEvents = recorder.record.mock.calls
      .map(([event]) => event as TelemetryEvent)
      .filter((event): event is TelemetryEvent & { name: "tool.call" } => event.name === "tool.call");

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({ tool: "boom", approved: true });
    expect(toolCallEvents[0]?.error).toHaveLength(500);
  });
});

describe("runTurn — max iterations", () => {
  it("emits outcome: max_iterations with iterations: 8 and rethrows when the model never stops calling tools", async () => {
    const alwaysToolCallTool = tool();
    const complete = vi.fn().mockResolvedValue(
      completionResult({ toolCalls: [{ id: "c", name: "noop", arguments: {} }], text: "" }),
    );
    const llmProvider: LlmProvider = { complete };
    const threadRepo = fakeThreadRepo();
    const recorder = fakeRecorder();

    await expect(
      runTurn(
        definition({ tools: [alwaysToolCallTool] }),
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
    ).rejects.toThrow(/MAX_ITERATIONS/);

    expect(complete).toHaveBeenCalledTimes(8);
    expect(threadRepo.appendMessages).not.toHaveBeenCalled();

    const event = recordedTurnEvent(recorder);
    expect(event).toMatchObject({ name: "turn", outcome: "max_iterations", iterations: 8 });
  });
});
