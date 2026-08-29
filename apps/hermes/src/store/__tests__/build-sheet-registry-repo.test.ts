import type { Pool } from "@hermes/store";
import { describe, expect, it, vi } from "vitest";
import { buildSheetRegistryRepo } from "../build-sheet-registry-repo";

function fakeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    slug: "appointments",
    spreadsheet_id: "sheet-123",
    description: "Appointments",
    access: "read",
    value_input_option: "USER_ENTERED",
    created_at: new Date("2026-08-01T00:00:00.000Z"),
    updated_at: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function mockPool(): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn() } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

describe("buildSheetRegistryRepo", () => {
  it("getBySlug calls straight through to the pool, with no caching", async () => {
    const pool = mockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [fakeRow({ access: "read" })] })
      .mockResolvedValueOnce({ rows: [fakeRow({ access: "readwrite" })] });
    const repo = buildSheetRegistryRepo(pool);

    const first = await repo.getBySlug("appointments");
    const second = await repo.getBySlug("appointments");

    expect(pool.query).toHaveBeenCalledTimes(2);
    // A registry mutation between two calls is visible on the second call —
    // proves this binder holds no in-memory snapshot of its own.
    expect(first?.access).toBe("read");
    expect(second?.access).toBe("readwrite");
  });

  it("listAll calls straight through to the pool, with no caching", async () => {
    const pool = mockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [fakeRow({ slug: "appointments" })] })
      .mockResolvedValueOnce({
        rows: [fakeRow({ slug: "appointments" }), fakeRow({ slug: "clients" })],
      });
    const repo = buildSheetRegistryRepo(pool);

    const first = await repo.listAll();
    const second = await repo.listAll();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(first.map((e) => e.slug)).toEqual(["appointments"]);
    // The second call, against a mutated table, sees the new row too —
    // nothing here freezes the list at construction or first read.
    expect(second.map((e) => e.slug)).toEqual(["appointments", "clients"]);
  });
});
