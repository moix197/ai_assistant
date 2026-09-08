import { assemblePrefix, createAgent } from "@hermes/agent";
import type { TelegramPoller } from "@hermes/channels";
import type {
  AccessTokenPort as CalendarAccessTokenPort,
  CalendarClient,
  CalendarToolDeps,
} from "@hermes/google-calendar";
import type {
  AccessTokenPort as GmailAccessTokenPort,
  GmailClient,
  GmailToolDeps,
} from "@hermes/google-gmail";
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

// Same spy-through-to-real-createAgent trick `build-agent.test.ts` uses, so
// this test can get its hands on the real `AgentDefinition` `buildAgent`
// constructs — this test's own regression is only meaningful against the
// *actual* registered tool list, not a hand-copied one that can drift.
vi.mock("@hermes/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hermes/agent")>();
  return { ...actual, createAgent: vi.fn(actual.createAgent) };
});

function createMockPool(rows: unknown[] = []): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

function createMockRecorder(): TelemetryRecorderHandle & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
}

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

function createFakeSheetWriteLogRepo(): SheetWriteLogPort {
  return { claim: vi.fn(), complete: vi.fn() };
}

/** Never exercised by this test (no Calendar tool call is triggered) — just needs to satisfy the type. */
function createFakeCalendarDeps(): CalendarToolDeps {
  const accessTokenPort: CalendarAccessTokenPort = { getAccessToken: vi.fn() };
  const calendarClient: CalendarClient = {
    getPrimaryCalendarTimeZone: vi.fn(),
    listEvents: vi.fn(),
    getEvent: vi.fn(),
    queryFreeBusy: vi.fn(),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
  };
  return { accessTokenPort, calendarClient };
}

/** Never exercised by this test (no Gmail tool call is triggered) — just needs to satisfy the type. */
function createFakeGmailDeps(): GmailToolDeps {
  const accessTokenPort: GmailAccessTokenPort = { getAccessToken: vi.fn() };
  const gmailClient: GmailClient = {
    listMessages: vi.fn(),
    getMessageMetadata: vi.fn(),
  };
  return { accessTokenPort, gmailClient };
}

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

describe("tool schemas — LLM wire-format regression", () => {
  it(`every tool in buildAgent's registered tool array converts to a JSON Schema with top-level type: "object"`, () => {
    // Regresses the production incident where sheets_write's
    // z.discriminatedUnion converted (via packages/agent/src/prompt.ts's
    // `assemblePrefix` — the exact function every completion request goes
    // through) to a top-level `anyOf` with no `type: "object"`. DeepSeek's
    // OpenAI-compatible API rejected the request outright, and because every
    // tool schema is sent on every turn, one bad schema broke all of them —
    // reads included, not just writes.
    buildAgent(
      createMockPool(),
      { complete: vi.fn() } as LlmProvider,
      "some-model",
      createMockRecorder(),
      new AbortController().signal,
      createMockChannel(),
      createFakeSheetsDeps(),
      createFakeSheetWriteLogRepo(),
      createFakeCalendarDeps(),
      createFakeGmailDeps(),
    );

    const definitionArg = vi.mocked(createAgent).mock.calls[0]?.[0];
    if (!definitionArg) throw new Error("createAgent was not called by buildAgent");
    expect(definitionArg.tools.length).toBeGreaterThan(0);

    const { toolDefs } = assemblePrefix(definitionArg);
    for (const toolDef of toolDefs) {
      expect(toolDef.parameters, `tool "${toolDef.name}"'s schema`).toMatchObject({
        type: "object",
      });
    }
  });
});
