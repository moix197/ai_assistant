import type { LlmProvider } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { describe, expect, it, vi } from "vitest";
import { buildAgent } from "../build-agent";

/** `rows` seeds every `pool.query` call, mirroring `build-llm-provider.test.ts`'s shape. */
function createMockPool(rows: unknown[] = []): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

function createMockRecorder(): TelemetryRecorderHandle & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
}

describe("buildAgent — wiring", () => {
  it("handleMessage delegates to the injected llmProvider and persists through the real pool", async () => {
    const pool = createMockPool([
      { id: "thread-1", channel: "telegram", chat_id: "555", messages: [] },
    ]);
    const complete = vi.fn().mockResolvedValue({
      text: "hi there",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "stop",
      costUsd: 0.0001,
    });
    const llmProvider: LlmProvider = { complete };
    const recorder = createMockRecorder();

    const agent = buildAgent(
      pool,
      llmProvider,
      "some-model",
      recorder,
      new AbortController().signal,
    );
    const reply = await agent.handleMessage("telegram", "555", "hello");

    expect(reply).toBe("hi there");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: "some-model", threadId: "thread-1" }),
    );
    // getOrCreateThread's INSERT and appendMessages' UPDATE both go through
    // the real, injected pool — proving buildThreadRepo is actually wired,
    // not a stub.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO threads"),
      expect.any(Array),
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE threads"),
      expect.any(Array),
    );
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ name: "turn", outcome: "completed" }),
    );
  });

  it("passes the AgentDefinition's tools (get_current_time) and the given model through to the provider request", async () => {
    const pool = createMockPool([
      { id: "thread-2", channel: "telegram", chat_id: "999", messages: [] },
    ]);
    const complete = vi.fn().mockResolvedValue({
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "stop",
      costUsd: 0,
    });
    const llmProvider: LlmProvider = { complete };

    const agent = buildAgent(
      pool,
      llmProvider,
      "another-model",
      createMockRecorder(),
      new AbortController().signal,
    );
    await agent.handleMessage("telegram", "999", "hi");

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "another-model",
        tools: [expect.objectContaining({ name: "get_current_time" })],
      }),
    );
  });
});
