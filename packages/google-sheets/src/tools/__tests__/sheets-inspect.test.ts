import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { SheetRegistryPort } from "../../sheet-registry-port";
import type { SheetMeta, SheetsClient } from "../../sheets-client";
import { createSheetsInspectTool } from "../sheets-inspect";

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
});
