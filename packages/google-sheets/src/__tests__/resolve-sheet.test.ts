import type { SheetRegistryEntry } from "@hermes/core";
import { describe, expect, it, vi } from "vitest";
import { resolveSheet } from "../resolve-sheet";
import type { SheetRegistryPort } from "../sheet-registry-port";

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

function fakeRegistry(entries: SheetRegistryEntry[]): SheetRegistryPort & {
  getBySlug: ReturnType<typeof vi.fn>;
  listAll: ReturnType<typeof vi.fn>;
} {
  return {
    getBySlug: vi.fn(async (slug: string) => entries.find((e) => e.slug === slug)),
    listAll: vi.fn(async () => entries),
  };
}

describe("resolveSheet", () => {
  it("resolves a known slug to its live registry entry", async () => {
    const entry = fakeEntry();
    const registry = fakeRegistry([entry]);

    const result = await resolveSheet(registry, "appointments");

    expect(result).toEqual({ ok: true, entry });
    // Known slug never pays for the extra listAll query.
    expect(registry.listAll).not.toHaveBeenCalled();
  });

  it("returns the structured unknown_sheet shape listing available slugs for an unknown slug", async () => {
    const registry = fakeRegistry([
      fakeEntry({ slug: "appointments" }),
      fakeEntry({ slug: "clients" }),
    ]);

    const result = await resolveSheet(registry, "mystery");

    expect(result).toEqual({
      ok: false,
      reason: "unknown_sheet",
      available: ["appointments", "clients"],
    });
  });

  it("returns the same unknown_sheet shape with available: [] for an empty registry, not an error", async () => {
    const registry = fakeRegistry([]);

    const result = await resolveSheet(registry, "anything");

    expect(result).toEqual({ ok: false, reason: "unknown_sheet", available: [] });
  });
});
