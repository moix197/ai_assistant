import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { SheetRegistryPort } from "../../sheet-registry-port";
import {
  SheetsAmbiguousWriteError,
  type SheetsClient,
  type SheetsWriteResult,
} from "../../sheets-client";
import { type SheetWriteLogPort, createSheetsWriteTool } from "../sheets-write";

const CTX = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

const CTX_OTHER_TURN = { ...CTX, turnId: "turn-2" };

function fakeEntry(overrides: Partial<SheetRegistryEntry> = {}): SheetRegistryEntry {
  return {
    slug: "clients",
    spreadsheetId: "sheet-123",
    description: "Clients",
    access: "readwrite",
    valueInputOption: "USER_ENTERED",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRegistry(entries: SheetRegistryEntry[]): SheetRegistryPort {
  return {
    getBySlug: vi.fn(async (slug: string) => entries.find((e) => e.slug === slug)),
    listAll: vi.fn(async () => entries),
  };
}

function fakeAccessTokenPort(token = "token-abc"): AccessTokenPort & {
  getAccessToken: ReturnType<typeof vi.fn>;
} {
  return { getAccessToken: vi.fn().mockResolvedValue(token) };
}

function fakeSheetsClient(
  writeResult: SheetsWriteResult = { updatedRange: "Sheet1!A2:B2", updatedRows: 1 },
): SheetsClient & {
  appendValues: ReturnType<typeof vi.fn>;
  updateValues: ReturnType<typeof vi.fn>;
} {
  return {
    getSpreadsheetMeta: vi.fn(),
    getValues: vi.fn(),
    appendValues: vi.fn().mockResolvedValue(writeResult),
    updateValues: vi.fn().mockResolvedValue(writeResult),
  };
}

/**
 * A real (in-memory) claim/complete implementation, not a dumb stub — the
 * dedupe tests below need genuine claim/complete semantics (same key
 * short-circuits, a fresh key doesn't) to actually prove the tool's dedupe
 * behavior, not just that it calls through to whatever the fake returns.
 */
function fakeSheetWriteLogRepo(): SheetWriteLogPort & {
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, { status: "pending" | "complete"; outcome?: unknown }>();
  const claim = vi.fn(async (dedupeKey: string) => {
    const existing = rows.get(dedupeKey);
    if (!existing) {
      rows.set(dedupeKey, { status: "pending" });
      return "claimed" as const;
    }
    if (existing.status === "complete") {
      return { alreadyComplete: true as const, outcome: existing.outcome };
    }
    return "claimed" as const;
  });
  const complete = vi.fn(async (dedupeKey: string, outcome: unknown) => {
    rows.set(dedupeKey, { status: "complete", outcome });
  });
  return { claim, complete };
}

const APPEND_ARGS = {
  mode: "append" as const,
  sheet: "clients",
  range: "Sheet1!A1:B1",
  values: [["Jane", "555-0100"]],
};

describe("sheets_write", () => {
  it("carries the right identity, schema (mode-discriminated), timeout, and requiresApproval", () => {
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(),
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    expect(tool.name).toBe("sheets_write");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.timeoutMs).toBe(30_000);

    expect(tool.schema.safeParse(APPEND_ARGS).success).toBe(true);
    expect(tool.schema.safeParse({ ...APPEND_ARGS, mode: "update" }).success).toBe(true);
    expect(tool.schema.safeParse({ ...APPEND_ARGS, mode: "delete" }).success).toBe(false);
    expect(tool.schema.safeParse({ sheet: "clients" }).success).toBe(false);
  });

  it("refuses a read-access sheet before any dedupe claim or API call", async () => {
    const sheetsClient = fakeSheetsClient();
    const accessTokenPort = fakeAccessTokenPort();
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry({ access: "read" })]),
      accessTokenPort,
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await tool.handler(APPEND_ARGS, CTX);

    expect(result).toEqual({ ok: false, reason: "read_only_sheet" });
    expect(sheetWriteLogRepo.claim).not.toHaveBeenCalled();
    expect(accessTokenPort.getAccessToken).not.toHaveBeenCalled();
    expect(sheetsClient.appendValues).not.toHaveBeenCalled();
    expect(sheetsClient.updateValues).not.toHaveBeenCalled();
  });

  it("refuses an unknown slug before any dedupe claim or API call", async () => {
    const sheetsClient = fakeSheetsClient();
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry({ slug: "appointments" })]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await tool.handler({ ...APPEND_ARGS, sheet: "mystery" }, CTX);

    expect(result).toEqual({ ok: false, reason: "unknown_sheet", available: ["appointments"] });
    expect(sheetWriteLogRepo.claim).not.toHaveBeenCalled();
    expect(sheetsClient.appendValues).not.toHaveBeenCalled();
  });

  it("happy path append: resolves the slug, calls appendValues once, records completion, and returns success", async () => {
    const writeResult: SheetsWriteResult = {
      updatedRange: "Sheet1!A2:B2",
      updatedRows: 1,
      updatedColumns: 2,
      updatedCells: 2,
    };
    const sheetsClient = fakeSheetsClient(writeResult);
    const accessTokenPort = fakeAccessTokenPort("token-abc");
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort,
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await tool.handler(APPEND_ARGS, CTX);

    expect(accessTokenPort.getAccessToken).toHaveBeenCalledWith("telegram", "111");
    expect(sheetsClient.appendValues).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "USER_ENTERED",
      undefined,
      CTX.signal,
    );
    expect(result).toEqual({ ok: true, sheet: "clients", mode: "append", ...writeResult });
    expect(sheetWriteLogRepo.complete).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
  });

  it("happy path update: calls updateValues once and returns success", async () => {
    const writeResult: SheetsWriteResult = { updatedRange: "Sheet1!A1:B1", updatedRows: 1 };
    const sheetsClient = fakeSheetsClient(writeResult);
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort("token-abc"),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    const result = await tool.handler({ ...APPEND_ARGS, mode: "update" }, CTX);

    expect(sheetsClient.updateValues).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "USER_ENTERED",
      CTX.signal,
    );
    expect(sheetsClient.appendValues).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, sheet: "clients", mode: "update", ...writeResult });
  });

  it("dedupe: an identical same-turn repeat calls the client exactly once, returning the same stored outcome", async () => {
    const sheetsClient = fakeSheetsClient();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    const first = await tool.handler(APPEND_ARGS, CTX);
    const second = await tool.handler(APPEND_ARGS, CTX);

    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("dedupe is a retry guard, not a permanent block: a different turnId (a later, genuinely repeated request) calls the client again", async () => {
    const sheetsClient = fakeSheetsClient();
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    await tool.handler(APPEND_ARGS, CTX);
    await tool.handler(APPEND_ARGS, CTX_OTHER_TURN);

    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(2);
    // Proves ctx.turnId actually reaches the dedupe-key computation, not
    // just that a second call happened to occur.
    const keys = sheetWriteLogRepo.claim.mock.calls.map((call) => call[0]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("mode: append's post-send ambiguous outcome is returned as a structured hedge, without the tool retrying the client", async () => {
    const sheetsClient = fakeSheetsClient();
    sheetsClient.appendValues.mockRejectedValueOnce(
      new SheetsAmbiguousWriteError("may or may not have landed"),
    );
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await tool.handler(APPEND_ARGS, CTX);

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_write",
      message: "may or may not have landed",
    });
    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
  });

  it("mode: update's post-send ambiguity is already resolved by the client — a resolved updateValues call returns a normal success with no hedge", async () => {
    // sheets-client.test.ts proves updateValues itself retries once,
    // internally, on a post-send-ambiguous failure and resolves to success.
    // This handler never sees that ambiguity at all — it only ever sees
    // updateValues's own success or a genuine thrown fatal error (no
    // try/catch here, unlike the append branch above).
    const writeResult: SheetsWriteResult = { updatedRange: "Sheet1!A1:B1", updatedRows: 1 };
    const sheetsClient = fakeSheetsClient(writeResult);
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    const result = await tool.handler({ ...APPEND_ARGS, mode: "update" }, CTX);

    expect(result).toEqual({ ok: true, sheet: "clients", mode: "update", ...writeResult });
  });

  it("valueInputOption resolution: falls back to the registry's default when the tool arg omits it", async () => {
    const sheetsClient = fakeSheetsClient();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry({ valueInputOption: "RAW" })]),
      accessTokenPort: fakeAccessTokenPort("token-abc"),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    await tool.handler(APPEND_ARGS, CTX);

    expect(sheetsClient.appendValues).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "RAW",
      undefined,
      CTX.signal,
    );
  });

  it("valueInputOption resolution: an explicit tool arg overrides the registry's default", async () => {
    const sheetsClient = fakeSheetsClient();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry({ valueInputOption: "USER_ENTERED" })]),
      accessTokenPort: fakeAccessTokenPort("token-abc"),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    await tool.handler({ ...APPEND_ARGS, valueInputOption: "RAW" }, CTX);

    expect(sheetsClient.appendValues).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      "Sheet1!A1:B1",
      [["Jane", "555-0100"]],
      "RAW",
      undefined,
      CTX.signal,
    );
  });
});
