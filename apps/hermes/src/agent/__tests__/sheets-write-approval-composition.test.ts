import type { ApprovalGate, ApprovalRequest, ThreadRepo } from "@hermes/agent";
import { createAgent } from "@hermes/agent";
import type { Logger } from "@hermes/core";
import type { GoogleAccount, GoogleAccountRepo } from "@hermes/google-auth";
import { IDENTITY_SCOPES, SHEETS_SCOPES, TOOL_REQUIRED_SCOPES } from "@hermes/google-auth";
import type {
  AccessTokenPort,
  SheetRegistryPort,
  SheetWriteLogPort,
  SheetsClient,
  SheetsWritePlan,
} from "@hermes/google-sheets";
import { createSheetsWriteTool } from "@hermes/google-sheets";
import type { LlmProvider } from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import { formatBatchPrompt } from "../approval-prompt-renderer";
import { withRequiredScopes } from "../with-required-scopes";

/**
 * Regression coverage for the incident where a real Telegram `sheets_write`
 * approval prompt rendered as raw JSON (`approval-prompt-renderer.ts`'s
 * all-fallback path) instead of the legible Spanish block — the gate had
 * received a `summary`-less `ApprovalRequest`.
 *
 * `build-agent.test.ts`/`sheets-tools-fail-closed.test.ts` both already wrap
 * the real `createSheetsWriteTool` in the real `withRequiredScopes` (the
 * exact composition `build-agent.ts` wires), but neither drives the result
 * through the real `createAgent`/`runTurn` gated-call path with a real
 * `ApprovalGate` — the one seam that actually produced the incident, since
 * every layer's own unit tests pass a hand-built `ApprovalRequest`/`ToolSpec`
 * rather than the object the real composition produces. This test closes
 * that gap: it builds the tool the same way `build-agent.ts` does, drives a
 * gated call through `createAgent(...).handleMessage`, and asserts both that
 * the fake gate receives a populated `summary` and that the real
 * `formatBatchPrompt` renders the legible block, not the raw-JSON fallback.
 */

const NOOP_LOGGER: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fakeAccount(): GoogleAccount {
  return {
    channel: "telegram",
    channelUserId: "111",
    chatId: "555",
    googleEmail: "person@example.com",
    scopes: [...IDENTITY_SCOPES, ...SHEETS_SCOPES],
    tokenEnvelope: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

function fakeGoogleAccountRepo(): GoogleAccountRepo {
  return {
    getAccount: vi.fn().mockResolvedValue(fakeAccount()),
    upsertAccount: vi.fn(),
    deleteAccount: vi.fn(),
  };
}

/** The one sheet this suite registers, matching the incident's real report ("clients", `Hoja 1!A2`). */
function fakeSheetRegistry(): SheetRegistryPort {
  return {
    getBySlug: vi.fn().mockImplementation(async (slug: string) =>
      slug === "clients"
        ? {
            slug: "clients",
            spreadsheetId: "sheet-id-1",
            description: "Client roster",
            access: "readwrite" as const,
            valueInputOption: "RAW" as const,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        : undefined,
    ),
    listAll: vi.fn().mockResolvedValue([]),
  };
}

function fakeSheetsClient(): SheetsClient {
  return {
    getSpreadsheetMeta: vi.fn(),
    getValues: vi.fn().mockResolvedValue({ range: "Hoja 1!A2", values: [["Old value"]] }),
    appendValues: vi.fn(),
    updateValues: vi.fn().mockResolvedValue({
      updatedRange: "Hoja 1!A2",
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    }),
  };
}

function fakeSheetWriteLogRepo(): SheetWriteLogPort {
  return {
    claim: vi.fn().mockResolvedValue("claimed"),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeThreadRepo(): ThreadRepo {
  return {
    getOrCreateThread: vi
      .fn()
      .mockResolvedValue({ id: "thread-1", channel: "telegram", chatId: "555", messages: [] }),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  };
}

/** Scripts one gated `sheets_write` call, then a plain final reply once the tool result comes back. */
function fakeLlmProvider(): LlmProvider {
  const complete = vi
    .fn()
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          name: "sheets_write",
          arguments: {
            mode: "update",
            sheet: "clients",
            range: "Hoja 1!A2",
            values: [["Test Dos"]],
          },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "tool_calls" as const,
      costUsd: 0,
    })
    .mockResolvedValueOnce({
      text: "listo",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "stop" as const,
      costUsd: 0,
    });
  return { complete };
}

describe("sheets_write gated call — real composition through createAgent", () => {
  it("the approval gate receives a populated summary and formatBatchPrompt renders the legible block, not the raw-JSON fallback", async () => {
    const accessTokenPort: AccessTokenPort = {
      getAccessToken: vi.fn().mockResolvedValue("token-abc"),
    };
    const sheetsWriteTool = withRequiredScopes<SheetsWritePlan>("sheets_write", {
      googleAccountRepo: fakeGoogleAccountRepo(),
      // Read from the same map `build-agent.ts` reads it from — not hardcoded here.
      requiredScopes: [...(TOOL_REQUIRED_SCOPES.get("sheets_write") ?? [])],
    })(
      createSheetsWriteTool({
        sheetRegistry: fakeSheetRegistry(),
        accessTokenPort,
        sheetsClient: fakeSheetsClient(),
        sheetWriteLogRepo: fakeSheetWriteLogRepo(),
        logger: NOOP_LOGGER,
      }),
    );

    let capturedBatch: ApprovalRequest[] | undefined;
    const approvalGate: ApprovalGate = {
      requestApproval: vi.fn(async (batch: ApprovalRequest[]) => {
        capturedBatch = batch;
        return "approved" as const;
      }),
    };

    const agent = createAgent(
      {
        name: "hermes",
        model: "test-model",
        systemPrompt: "You are Hermes, a helpful assistant.",
        tools: [sheetsWriteTool],
        channels: ["telegram"],
      },
      {
        llmProvider: fakeLlmProvider(),
        threadRepo: fakeThreadRepo(),
        signal: new AbortController().signal,
        approvalGate,
      },
    );

    await agent.handleMessage("telegram", "555", "111", "actualiza la fila 2 de clients");

    expect(approvalGate.requestApproval).toHaveBeenCalledTimes(1);
    expect(capturedBatch).toBeDefined();
    const request = capturedBatch?.[0];
    expect(request?.tool).toBe("sheets_write");
    // The bug: `spec.prepare` was falsy at the gated-call dispatch, so
    // `batchEntry` carried only `{ tool, args }` — no `plan`, no `summary`.
    expect(request?.plan).toBeDefined();
    expect(request?.summary).toEqual({
      action: "¿Reemplazar una fila en clients?",
      target: "Client roster",
      items: ["Test Dos"],
      itemsTotal: 1,
      effects: ["Sobrescribe una fila que ya existe."],
    });

    const rendered = formatBatchPrompt(capturedBatch ?? []);
    expect(rendered).not.toContain("The model wants to run:");
    expect(rendered).not.toContain("sheets_write({");
    expect(rendered).toContain("¿Reemplazar una fila en clients?");
    expect(rendered).toContain("Client roster");
    expect(rendered).toContain("Sobrescribe una fila que ya existe.");
  });
});
