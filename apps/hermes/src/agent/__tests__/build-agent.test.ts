import { createAgent } from "@hermes/agent";
import type { TelegramPoller } from "@hermes/channels";
import type {
  AccessTokenPort,
  SheetRegistryPort,
  SheetWriteLogPort,
  SheetsClient,
  SheetsToolDeps,
} from "@hermes/google-sheets";
import type { LlmProvider } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { describe, expect, it, vi } from "vitest";
import { buildAgent } from "../build-agent";

// Spies through to the real `createAgent` (no behavior change) so a test can
// inspect the `AgentDefinition` it was actually called with — in particular
// each `ToolSpec.requiresApproval`, a field `assemblePrefix` strips before
// anything reaches the provider request, so it's otherwise unobservable from
// outside `buildAgent`.
vi.mock("@hermes/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hermes/agent")>();
  return { ...actual, createAgent: vi.fn(actual.createAgent) };
});

/** `rows` seeds every `pool.query` call, mirroring `build-llm-provider.test.ts`'s shape. */
function createMockPool(rows: unknown[] = []): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

function createMockRecorder(): TelemetryRecorderHandle & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
}

/** Never exercised by these tests (no Sheets tool call is triggered) — just needs to satisfy the type. */
function createFakeSheetsDeps(): SheetsToolDeps {
  const sheetRegistry: SheetRegistryPort = {
    getBySlug: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
  };
  const accessTokenPort: AccessTokenPort = { getAccessToken: vi.fn() };
  const sheetsClient: SheetsClient = {
    getSpreadsheetMeta: vi.fn(),
    getValues: vi.fn(),
    appendValues: vi.fn(),
    updateValues: vi.fn(),
  };
  return { sheetRegistry, accessTokenPort, sheetsClient };
}

/** Never exercised by these tests (no sheets_write tool call is triggered) — just needs to satisfy the type. */
function createFakeSheetWriteLogRepo(): SheetWriteLogPort {
  return { claim: vi.fn(), complete: vi.fn() };
}

/** Never exercised by these tests (no gated tool call is triggered) — just needs to satisfy the type. */
function createMockChannel(): TelegramPoller {
  return {
    capabilities: { markdown: true, files: true, buttons: true, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    subscribeCallback: vi.fn(),
    send: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    answerCallback: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
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

    const { agent } = buildAgent(
      pool,
      llmProvider,
      "some-model",
      recorder,
      new AbortController().signal,
      createMockChannel(),
      createFakeSheetsDeps(),
      createFakeSheetWriteLogRepo(),
    );
    const reply = await agent.handleMessage("telegram", "555", "111", "hello");

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

  it("passes the AgentDefinition's tools (get_current_time, echo, sheets_inspect, sheets_read, sheets_write, whoami) and the given model through to the provider request", async () => {
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

    const { agent } = buildAgent(
      pool,
      llmProvider,
      "another-model",
      createMockRecorder(),
      new AbortController().signal,
      createMockChannel(),
      createFakeSheetsDeps(),
      createFakeSheetWriteLogRepo(),
    );
    await agent.handleMessage("telegram", "999", "111", "hi");

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "another-model",
        // assemblePrefix (packages/agent/src/prompt.ts) sorts tools by name
        // for deterministic output — "echo" precedes "get_current_time"
        // precedes "sheets_inspect" precedes "sheets_read" precedes
        // "sheets_write" precedes "whoami". The existing prefix (echo,
        // get_current_time, whoami) is byte-stable — 05-google-sheets Phase 4
        // inserted the two read entries, Phase 5 inserts sheets_write.
        tools: [
          expect.objectContaining({ name: "echo" }),
          expect.objectContaining({ name: "get_current_time" }),
          expect.objectContaining({ name: "sheets_inspect" }),
          expect.objectContaining({ name: "sheets_read" }),
          expect.objectContaining({ name: "sheets_write" }),
          expect.objectContaining({ name: "whoami" }),
        ],
      }),
    );

    // sheets_write is the one Sheets tool gated behind approval — the two
    // read tools never are. `requiresApproval` never reaches the provider
    // request (assemblePrefix strips it), so this reads it off the actual
    // AgentDefinition `createAgent` was called with instead.
    const definitionArg = vi.mocked(createAgent).mock.calls[0]?.[0];
    const byName = (name: string) => definitionArg?.tools.find((tool) => tool.name === name);
    expect(byName("sheets_write")?.requiresApproval).toBe(true);
    expect(byName("sheets_inspect")?.requiresApproval).toBe(false);
    expect(byName("sheets_read")?.requiresApproval).toBe(false);
  });

  it("constructing the agent does not itself touch the Sheets deps — nothing is called until a turn actually invokes a Sheets tool", async () => {
    const pool = createMockPool([
      { id: "thread-3", channel: "telegram", chat_id: "888", messages: [] },
    ]);
    const complete = vi.fn().mockResolvedValue({
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "stop",
      costUsd: 0,
    });
    const llmProvider: LlmProvider = { complete };
    const sheetsDeps = createFakeSheetsDeps();
    const sheetWriteLogRepo = createFakeSheetWriteLogRepo();

    const { agent } = buildAgent(
      pool,
      llmProvider,
      "some-model",
      createMockRecorder(),
      new AbortController().signal,
      createMockChannel(),
      sheetsDeps,
      sheetWriteLogRepo,
    );
    await agent.handleMessage("telegram", "888", "111", "hi");

    expect(sheetsDeps.sheetRegistry.getBySlug).not.toHaveBeenCalled();
    expect(sheetsDeps.sheetRegistry.listAll).not.toHaveBeenCalled();
    expect(sheetsDeps.accessTokenPort.getAccessToken).not.toHaveBeenCalled();
    expect(sheetsDeps.sheetsClient.getSpreadsheetMeta).not.toHaveBeenCalled();
    expect(sheetsDeps.sheetsClient.getValues).not.toHaveBeenCalled();
    expect(sheetsDeps.sheetsClient.appendValues).not.toHaveBeenCalled();
    expect(sheetsDeps.sheetsClient.updateValues).not.toHaveBeenCalled();
    expect(sheetWriteLogRepo.claim).not.toHaveBeenCalled();
    expect(sheetWriteLogRepo.complete).not.toHaveBeenCalled();
  });
});
