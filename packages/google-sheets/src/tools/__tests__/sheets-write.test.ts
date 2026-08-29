import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { SheetRegistryPort } from "../../sheet-registry-port";
import {
  SheetsAmbiguousWriteError,
  SheetsApiError,
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
  release: ReturnType<typeof vi.fn>;
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
    // Mirrors the real repo: a still-pending row is never fail-open —
    // proceeding to write again could double-append.
    return { alreadyPending: true as const };
  });
  const complete = vi.fn(async (dedupeKey: string, outcome: unknown) => {
    rows.set(dedupeKey, { status: "complete", outcome });
  });
  // Mirrors the real repo's release: only ever deletes a still-pending row,
  // never one a legitimate complete() already recorded.
  const release = vi.fn(async (dedupeKey: string) => {
    const existing = rows.get(dedupeKey);
    if (existing?.status === "pending") {
      rows.delete(dedupeKey);
    }
  });
  return { claim, complete, release };
}

const APPEND_ARGS = {
  mode: "append" as const,
  sheet: "clients",
  range: "Sheet1!A1:B1",
  values: [["Jane", "555-0100"]],
};

/**
 * Runs the full gated pipeline a real turn would: `prepare` (peeling off the
 * resolved plan) then `handler` fed that plan — never `handler` in
 * isolation, since (`06-legible-approvals-bounded-reads` Phase 3) it no
 * longer resolves the sheet itself. Throws if `prepare` refuses, since every
 * caller below only reaches for this helper against a known, resolvable
 * sheet — an unknown-slug/read-only-access refusal is tested against
 * `prepare`/`handler` directly instead.
 */
async function prepareAndRun(
  tool: ReturnType<typeof createSheetsWriteTool>,
  args: unknown,
  ctx: typeof CTX = CTX,
): Promise<unknown> {
  const prepared = await tool.prepare(args, ctx);
  if (!prepared.ok) {
    throw new Error("fixture bug: expected prepare to succeed for a known sheet");
  }
  return tool.handler(args, { ...ctx, plan: prepared.plan });
}

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

  describe("prepare", () => {
    it("resolves a known sheet's plan and a minimal ApprovalSummary naming it", async () => {
      const tool = createSheetsWriteTool({
        sheetRegistry: fakeRegistry([fakeEntry({ valueInputOption: "RAW" })]),
        accessTokenPort: fakeAccessTokenPort(),
        sheetsClient: fakeSheetsClient(),
        sheetWriteLogRepo: fakeSheetWriteLogRepo(),
      });

      const result = await tool.prepare(APPEND_ARGS, CTX);

      expect(result).toEqual({
        ok: true,
        plan: {
          sheetSlug: "clients",
          spreadsheetId: "sheet-123",
          effectiveValueInputOption: "RAW",
        },
        summary: {
          action: "¿Escribir en clients?",
          target: "Clients",
          effects: [],
        },
      });
    });

    it("falls back to no target when the registered sheet's description is empty", async () => {
      const tool = createSheetsWriteTool({
        sheetRegistry: fakeRegistry([fakeEntry({ description: "" })]),
        accessTokenPort: fakeAccessTokenPort(),
        sheetsClient: fakeSheetsClient(),
        sheetWriteLogRepo: fakeSheetWriteLogRepo(),
      });

      const result = await tool.prepare(APPEND_ARGS, CTX);

      expect(result).toMatchObject({ ok: true, summary: { action: "¿Escribir en clients?" } });
      expect((result as { summary: { target?: string } }).summary.target).toBeUndefined();
    });

    it("refuses a read-access sheet with the unchanged read_only_sheet shape, before any dedupe claim or API call (06-legible-approvals-bounded-reads Phase 4: moved from the handler so no approval prompt is ever sent for it)", async () => {
      const sheetsClient = fakeSheetsClient();
      const accessTokenPort = fakeAccessTokenPort();
      const sheetWriteLogRepo = fakeSheetWriteLogRepo();
      const tool = createSheetsWriteTool({
        sheetRegistry: fakeRegistry([fakeEntry({ access: "read" })]),
        accessTokenPort,
        sheetsClient,
        sheetWriteLogRepo,
      });

      const result = await tool.prepare(APPEND_ARGS, CTX);

      expect(result).toEqual({
        ok: false,
        result: { ok: false, reason: "read_only_sheet" },
      });
      expect(sheetWriteLogRepo.claim).not.toHaveBeenCalled();
      expect(accessTokenPort.getAccessToken).not.toHaveBeenCalled();
      expect(sheetsClient.appendValues).not.toHaveBeenCalled();
      expect(sheetsClient.updateValues).not.toHaveBeenCalled();
    });

    it("returns the unchanged unknown_sheet refusal shape for an unknown slug, without calling the client", async () => {
      const sheetsClient = fakeSheetsClient();
      const tool = createSheetsWriteTool({
        sheetRegistry: fakeRegistry([fakeEntry({ slug: "appointments" })]),
        accessTokenPort: fakeAccessTokenPort(),
        sheetsClient,
        sheetWriteLogRepo: fakeSheetWriteLogRepo(),
      });

      const result = await tool.prepare({ ...APPEND_ARGS, sheet: "mystery" }, CTX);

      expect(result).toEqual({
        ok: false,
        result: { ok: false, reason: "unknown_sheet", available: ["appointments"] },
      });
      expect(sheetsClient.appendValues).not.toHaveBeenCalled();
      expect(sheetsClient.updateValues).not.toHaveBeenCalled();
    });
  });

  it("handler reads ctx.plan instead of re-resolving the sheet — the registry is queried exactly once per call, not twice", async () => {
    const sheetRegistry = fakeRegistry([fakeEntry()]);
    const tool = createSheetsWriteTool({
      sheetRegistry,
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(),
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    await prepareAndRun(tool, APPEND_ARGS);

    expect(sheetRegistry.getBySlug).toHaveBeenCalledTimes(1);
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

    const result = await prepareAndRun(tool, APPEND_ARGS);

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

    const result = await prepareAndRun(tool, { ...APPEND_ARGS, mode: "update" });

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

    const first = await prepareAndRun(tool, APPEND_ARGS);
    const second = await prepareAndRun(tool, APPEND_ARGS);

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

    await prepareAndRun(tool, APPEND_ARGS, CTX);
    await prepareAndRun(tool, APPEND_ARGS, CTX_OTHER_TURN);

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

    const result = await prepareAndRun(tool, APPEND_ARGS);

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_write",
      message: "may or may not have landed",
    });
    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
  });

  it("mode: append's genuinely ambiguous post-send failure still blocks a same-turn retry with the same hedge, without a second client call", async () => {
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

    const first = await prepareAndRun(tool, APPEND_ARGS);
    const second = await prepareAndRun(tool, APPEND_ARGS);

    expect(second).toEqual(first);
    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.release).not.toHaveBeenCalled();
  });

  it("mode: append's definitively-failed write (a 4xx SheetsApiError, reached Google and was rejected) releases the pending claim instead of leaving it stuck ambiguous, and a same-turn retry can call the client again", async () => {
    const sheetsClient = fakeSheetsClient();
    const apiError = new SheetsApiError("Sheets API returned HTTP 400: bad request", 400);
    sheetsClient.appendValues.mockRejectedValueOnce(apiError);
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    await expect(prepareAndRun(tool, APPEND_ARGS)).rejects.toBe(apiError);

    expect(sheetWriteLogRepo.release).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).not.toHaveBeenCalled();

    // The claim was released, not left pending — a same-turn retry (same
    // channel/channelUserId/turnId/args) is allowed to call the client
    // again rather than being told the write is ambiguous.
    const result = await prepareAndRun(tool, APPEND_ARGS);

    expect(sheetsClient.appendValues).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      sheet: "clients",
      mode: "append",
      updatedRange: "Sheet1!A2:B2",
      updatedRows: 1,
    });
  });

  it("mode: update's post-send ambiguity is already resolved by the client — a resolved updateValues call returns a normal success with no hedge, the opposite outcome from the append-mode ambiguity test above for the same fault class", async () => {
    // sheets-client.test.ts proves updateValues itself retries once,
    // internally, on a post-send-ambiguous failure and resolves to success.
    // This handler never sees that ambiguity at all — it only ever sees
    // updateValues's own success or a genuine thrown fatal error (no
    // try/catch here, unlike the append branch above). The fake client can't
    // simulate the internal retry itself (that's `sheets-client.test.ts`'s
    // job), but this test still proves the TOOL layer's half of the split:
    // exactly one call reaches the fake, no `ambiguous_write` hedge is ever
    // produced, and the outcome recorded via `complete` is the plain
    // success — mirroring the append test's assertions line for line so the
    // pair actually asserts opposite outcomes, not just opposite prose.
    const writeResult: SheetsWriteResult = { updatedRange: "Sheet1!A1:B1", updatedRows: 1 };
    const sheetsClient = fakeSheetsClient(writeResult);
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await prepareAndRun(tool, { ...APPEND_ARGS, mode: "update" });

    expect(result).toEqual({ ok: true, sheet: "clients", mode: "update", ...writeResult });
    expect(sheetsClient.updateValues).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).toHaveBeenCalledWith(expect.any(String), result);
  });

  it("mode: update's definitively-failed write (a 4xx SheetsApiError, reached Google and was rejected) releases the pending claim instead of leaving it stuck ambiguous, and a same-turn retry can call the client again — mirrors the append-mode release test above; the asymmetry this used to guard was a real bug (code review, 05-google-sheets close-out)", async () => {
    const sheetsClient = fakeSheetsClient();
    const apiError = new SheetsApiError("Sheets API returned HTTP 400: bad request", 400);
    sheetsClient.updateValues.mockRejectedValueOnce(apiError);
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });
    const updateArgs = { ...APPEND_ARGS, mode: "update" as const };

    await expect(prepareAndRun(tool, updateArgs)).rejects.toBe(apiError);

    expect(sheetWriteLogRepo.release).toHaveBeenCalledTimes(1);
    expect(sheetWriteLogRepo.complete).not.toHaveBeenCalled();

    // The claim was released, not left pending — a same-turn retry (same
    // channel/channelUserId/turnId/args) is allowed to call the client
    // again rather than being told the write is ambiguous.
    const result = await prepareAndRun(tool, updateArgs);

    expect(sheetsClient.updateValues).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      sheet: "clients",
      mode: "update",
      updatedRange: "Sheet1!A2:B2",
      updatedRows: 1,
    });
  });

  it("mode: update's genuinely ambiguous failure (not a SheetsApiError — e.g. updateValues's own internal retry exhausted on a post-send network failure) leaves the claim pending, blocking a same-turn retry with the ambiguous hedge, without a second client call", async () => {
    const sheetsClient = fakeSheetsClient();
    const networkError = new Error("Sheets request failed: fetch failed");
    sheetsClient.updateValues.mockRejectedValueOnce(networkError);
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });
    const updateArgs = { ...APPEND_ARGS, mode: "update" as const };

    await expect(prepareAndRun(tool, updateArgs)).rejects.toBe(networkError);

    expect(sheetWriteLogRepo.release).not.toHaveBeenCalled();
    expect(sheetWriteLogRepo.complete).not.toHaveBeenCalled();

    // Not released: a same-turn retry finds the row still pending and gets
    // the same ambiguous hedge a fresh alreadyPending claim always gets,
    // without ever calling the client a second time.
    const result = await prepareAndRun(tool, updateArgs);

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_write",
      message: expect.stringContaining("may or may not have landed"),
    });
    expect(sheetsClient.updateValues).toHaveBeenCalledTimes(1);
  });

  it("a claim that finds an EXISTING pending row for this key returns the ambiguous hedge without calling the client or recording a new outcome", async () => {
    const sheetsClient = fakeSheetsClient();
    const sheetWriteLogRepo = fakeSheetWriteLogRepo();
    sheetWriteLogRepo.claim.mockResolvedValueOnce({ alreadyPending: true });
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
      sheetWriteLogRepo,
    });

    const result = await prepareAndRun(tool, APPEND_ARGS);

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_write",
      message: expect.stringContaining("may or may not have landed"),
    });
    expect(sheetsClient.appendValues).not.toHaveBeenCalled();
    expect(sheetsClient.updateValues).not.toHaveBeenCalled();
    // Not this call's write to record — stamping it here would risk
    // clobbering whichever attempt actually owns the pending row's eventual
    // completion.
    expect(sheetWriteLogRepo.complete).not.toHaveBeenCalled();
  });

  it("valueInputOption resolution: falls back to the registry's default when the tool arg omits it", async () => {
    const sheetsClient = fakeSheetsClient();
    const tool = createSheetsWriteTool({
      sheetRegistry: fakeRegistry([fakeEntry({ valueInputOption: "RAW" })]),
      accessTokenPort: fakeAccessTokenPort("token-abc"),
      sheetsClient,
      sheetWriteLogRepo: fakeSheetWriteLogRepo(),
    });

    await prepareAndRun(tool, APPEND_ARGS);

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

    await prepareAndRun(tool, { ...APPEND_ARGS, valueInputOption: "RAW" });

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
