import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { SheetRegistryPort } from "../../sheet-registry-port";
import type { SheetMeta, SheetsClient } from "../../sheets-client";
import { createSheetsInspectTool } from "../sheets-inspect";

/**
 * Builds a `SheetMeta` with one tab per entry in `headerLens` — each tab's
 * header row is `headerLens[i]` single-char cells, so its cell count
 * (`cells` in `sheets-inspect.ts`'s `measure`) is exactly `headerLens[i]`.
 * Titles are distinguishable (`Tab1`, `Tab2`, ...) so tab order is
 * observable in assertions; sheetId is fixed since it's not exercised. The
 * per-index digit is the only length variation across tabs, which keeps the
 * char cap comfortably out of reach in tests that only mean to exercise the
 * cell cap.
 */
function makeMetaWithHeaderLens(headerLens: number[]): SheetMeta {
  return {
    sheets: headerLens.map((len, i) => ({
      properties: { sheetId: 0, title: `Tab${i + 1}` },
      data: [
        {
          rowData: [{ values: Array.from({ length: len }, () => ({ formattedValue: "h" })) }],
        },
      ],
    })),
  };
}

const CTX = {
  signal: new AbortController().signal,
  channel: "telegram",
  channelUserId: "111",
  turnId: "turn-1",
};

function fakeEntry(overrides: Partial<SheetRegistryEntry> = {}): SheetRegistryEntry {
  return {
    slug: "appointments",
    spreadsheetId: "sheet-123",
    description: "Appointments",
    access: "read",
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

function fakeSheetsClient(meta: SheetMeta): SheetsClient & {
  getSpreadsheetMeta: ReturnType<typeof vi.fn>;
  getValues: ReturnType<typeof vi.fn>;
} {
  return {
    getSpreadsheetMeta: vi.fn().mockResolvedValue(meta),
    getValues: vi.fn(),
    // Never exercised here (sheets_inspect never writes) — just needs to
    // satisfy SheetsClient, widened by 05-google-sheets Phase 5.
    appendValues: vi.fn(),
    updateValues: vi.fn(),
  };
}

describe("sheets_inspect", () => {
  it("carries the right identity, schema, and timeout", () => {
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient({ sheets: [] }),
    });

    expect(tool.name).toBe("sheets_inspect");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.timeoutMs).toBe(30_000);
    expect(tool.schema.safeParse({ sheet: "appointments" }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it("happy path: resolves the slug, fetches metadata, and returns tab summaries", async () => {
    const meta: SheetMeta = {
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Sheet1",
            gridProperties: { rowCount: 100, columnCount: 5 },
          },
          data: [
            { rowData: [{ values: [{ formattedValue: "Name" }, { formattedValue: "Phone" }] }] },
          ],
        },
      ],
    };
    const sheetsClient = fakeSheetsClient(meta);
    const accessTokenPort = fakeAccessTokenPort("token-abc");
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort,
      sheetsClient,
    });

    const result = await tool.handler({ sheet: "appointments" }, CTX);

    expect(accessTokenPort.getAccessToken).toHaveBeenCalledWith("telegram", "111");
    expect(sheetsClient.getSpreadsheetMeta).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      CTX.signal,
    );
    expect(result).toEqual({
      ok: true,
      sheet: "appointments",
      tabs: [
        {
          title: "Sheet1",
          sheetId: 0,
          rowCount: 100,
          columnCount: 5,
          headerRow: ["Name", "Phone"],
        },
      ],
    });
  });

  it("unknown slug short-circuits before any access token fetch or client call", async () => {
    const accessTokenPort = fakeAccessTokenPort();
    const sheetsClient = fakeSheetsClient({ sheets: [] });
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry({ slug: "clients" })]),
      accessTokenPort,
      sheetsClient,
    });

    const result = await tool.handler({ sheet: "mystery" }, CTX);

    expect(result).toEqual({ ok: false, reason: "unknown_sheet", available: ["clients"] });
    expect(accessTokenPort.getAccessToken).not.toHaveBeenCalled();
    expect(sheetsClient.getSpreadsheetMeta).not.toHaveBeenCalled();
  });

  it("stays untruncated exactly at the cap boundary — no new keys at all", async () => {
    // 5 tabs x 100 header cells = exactly MAX_CELLS (500); must not truncate.
    const meta = makeMetaWithHeaderLens([100, 100, 100, 100, 100]);
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(meta),
    });

    const result = await tool.handler({ sheet: "appointments" }, CTX);

    expect(result).toEqual({
      ok: true,
      sheet: "appointments",
      tabs: summarizeExpectedTabs(meta),
    });
  });

  it("truncates a spreadsheet with enough tabs to exceed the cell cap, returning whole tabs plus the truncation fields", async () => {
    // 6 tabs x 100 header cells each — the 6th pushes cumulative cells to
    // 600 > MAX_CELLS, so only the first 5 are returned.
    const meta = makeMetaWithHeaderLens([100, 100, 100, 100, 100, 100]);
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(meta),
    });

    const result = await tool.handler({ sheet: "appointments" }, CTX);

    expect(result).toMatchObject({
      ok: true,
      sheet: "appointments",
      truncated: true,
      returnedTabs: 5,
      totalTabs: 6,
      note: "La planilla tiene más pestañas de las que se muestran acá — solo se listan las primeras.",
    });
    const tabs = (result as { tabs: { title: string }[] }).tabs;
    expect(tabs).toHaveLength(5);
    expect(tabs.map((tab) => tab.title)).toEqual(["Tab1", "Tab2", "Tab3", "Tab4", "Tab5"]);
  });

  it("a tab with an empty header row contributes zero cells and is kept, still counting correctly toward returnedTabs/totalTabs", async () => {
    // 5 tabs fill the cap exactly (500 cells). A 6th, blank-header tab
    // contributes 0 cells, so it doesn't itself trip the cap and is kept.
    // A 7th, wide tab then pushes over the cap and is dropped.
    const meta = makeMetaWithHeaderLens([100, 100, 100, 100, 100, 0, 100]);
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(meta),
    });

    const result = await tool.handler({ sheet: "appointments" }, CTX);

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      returnedTabs: 6,
      totalTabs: 7,
    });
    const tabs = (result as { tabs: { headerRow: string[] }[] }).tabs;
    expect(tabs).toHaveLength(6);
    expect(tabs[5]?.headerRow).toEqual([]);
  });

  it("returns a single tab whose header row alone exceeds the cell cap whole, never split", async () => {
    const meta = makeMetaWithHeaderLens([600]);
    const tool = createSheetsInspectTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient(meta),
    });

    const result = await tool.handler({ sheet: "appointments" }, CTX);

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      returnedTabs: 1,
      totalTabs: 1,
    });
    const tabs = (result as { tabs: { headerRow: string[] }[] }).tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.headerRow).toHaveLength(600);
  });
});

/** Mirrors `summarizeTabs` in `sheets-inspect.ts` for building expected untruncated output. */
function summarizeExpectedTabs(meta: SheetMeta) {
  return meta.sheets.map((sheet) => ({
    title: sheet.properties.title,
    sheetId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties?.rowCount,
    columnCount: sheet.properties.gridProperties?.columnCount,
    headerRow: (sheet.data?.[0]?.rowData?.[0]?.values ?? []).map(
      (cell) => cell.formattedValue ?? "",
    ),
  }));
}
