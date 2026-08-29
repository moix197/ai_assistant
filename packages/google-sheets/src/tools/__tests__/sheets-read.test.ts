import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTokenPort } from "../../access-token-port";
import type { SheetRegistryPort } from "../../sheet-registry-port";
import type { SheetsClient, SheetsValuesResult } from "../../sheets-client";
import { createSheetsReadTool } from "../sheets-read";

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

function fakeSheetsClient(values: SheetsValuesResult): SheetsClient & {
  getSpreadsheetMeta: ReturnType<typeof vi.fn>;
  getValues: ReturnType<typeof vi.fn>;
} {
  return {
    getSpreadsheetMeta: vi.fn(),
    getValues: vi.fn().mockResolvedValue(values),
  };
}

describe("sheets_read", () => {
  it("carries the right identity, schema (with valueRenderOption defaulting), and timeout", () => {
    const tool = createSheetsReadTool({
      sheetRegistry: fakeRegistry([]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient: fakeSheetsClient({ range: "Sheet1!A1:A1", values: [] }),
    });

    expect(tool.name).toBe("sheets_read");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.timeoutMs).toBe(30_000);

    const parsed = tool.schema.safeParse({ sheet: "appointments", range: "Sheet1!A1:D20" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { valueRenderOption: string }).valueRenderOption).toBe(
        "FORMATTED_VALUE",
      );
    }
    expect(tool.schema.safeParse({ sheet: "appointments" }).success).toBe(false);
  });

  it("happy path: resolves the slug, fetches values, and returns them", async () => {
    const values: SheetsValuesResult = {
      range: "Sheet1!A1:B2",
      values: [
        ["Name", "Phone"],
        ["Jane", "555-0100"],
      ],
    };
    const sheetsClient = fakeSheetsClient(values);
    const accessTokenPort = fakeAccessTokenPort("token-abc");
    const tool = createSheetsReadTool({
      sheetRegistry: fakeRegistry([fakeEntry()]),
      accessTokenPort,
      sheetsClient,
    });

    const result = await tool.handler(
      { sheet: "appointments", range: "Sheet1!A1:B2", valueRenderOption: "FORMATTED_VALUE" },
      CTX,
    );

    expect(accessTokenPort.getAccessToken).toHaveBeenCalledWith("telegram", "111");
    expect(sheetsClient.getValues).toHaveBeenCalledWith(
      "token-abc",
      "sheet-123",
      "Sheet1!A1:B2",
      "FORMATTED_VALUE",
      CTX.signal,
    );
    expect(result).toEqual({
      ok: true,
      sheet: "appointments",
      range: "Sheet1!A1:B2",
      values: values.values,
    });
  });

  it("permits a read against a read-access sheet (no access check for reads)", async () => {
    const sheetsClient = fakeSheetsClient({ range: "Sheet1!A1:A1", values: [["x"]] });
    const tool = createSheetsReadTool({
      sheetRegistry: fakeRegistry([fakeEntry({ access: "read" })]),
      accessTokenPort: fakeAccessTokenPort(),
      sheetsClient,
    });

    const result = await tool.handler(
      { sheet: "appointments", range: "Sheet1!A1:A1", valueRenderOption: "FORMATTED_VALUE" },
      CTX,
    );

    expect(sheetsClient.getValues).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });

  it("unknown slug short-circuits before any access token fetch or client call", async () => {
    const accessTokenPort = fakeAccessTokenPort();
    const sheetsClient = fakeSheetsClient({ range: "", values: [] });
    const tool = createSheetsReadTool({
      sheetRegistry: fakeRegistry([fakeEntry({ slug: "clients" })]),
      accessTokenPort,
      sheetsClient,
    });

    const result = await tool.handler(
      { sheet: "mystery", range: "A1:A1", valueRenderOption: "FORMATTED_VALUE" },
      CTX,
    );

    expect(result).toEqual({ ok: false, reason: "unknown_sheet", available: ["clients"] });
    expect(accessTokenPort.getAccessToken).not.toHaveBeenCalled();
    expect(sheetsClient.getValues).not.toHaveBeenCalled();
  });
});
