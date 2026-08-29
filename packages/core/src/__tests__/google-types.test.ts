import { describe, expect, it } from "vitest";
import { sheetRegistryEntrySchema } from "../google-types";

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    slug: "clients",
    spreadsheetId: "1AbCdEf",
    description: "Client roster",
    access: "readwrite",
    valueInputOption: "USER_ENTERED",
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sheetRegistryEntrySchema", () => {
  it("parses a valid entry", () => {
    const candidate = entry();
    expect(sheetRegistryEntrySchema.parse(candidate)).toEqual(candidate);
  });

  it("parses the 'read' access value", () => {
    const candidate = entry({ access: "read" });
    expect(sheetRegistryEntrySchema.parse(candidate)).toEqual(candidate);
  });

  it("parses the 'RAW' valueInputOption value", () => {
    const candidate = entry({ valueInputOption: "RAW" });
    expect(sheetRegistryEntrySchema.parse(candidate)).toEqual(candidate);
  });

  it("rejects an invalid access value", () => {
    const result = sheetRegistryEntrySchema.safeParse(entry({ access: "admin" }));
    expect(result.success).toBe(false);
  });

  it("rejects an invalid valueInputOption value", () => {
    const result = sheetRegistryEntrySchema.safeParse(entry({ valueInputOption: "FANCY" }));
    expect(result.success).toBe(false);
  });

  it("rejects an empty slug", () => {
    const result = sheetRegistryEntrySchema.safeParse(entry({ slug: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an empty spreadsheetId", () => {
    const result = sheetRegistryEntrySchema.safeParse(entry({ spreadsheetId: "" }));
    expect(result.success).toBe(false);
  });
});
