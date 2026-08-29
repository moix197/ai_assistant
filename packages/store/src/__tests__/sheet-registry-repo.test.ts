import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMigrationsDir, runMigrations } from "../migrate";
import { getBySlug, listAll, remove, upsert } from "../sheet-registry-repo";

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
import { testDatabaseUrl } from "./db-env";

describe.skipIf(!testDatabaseUrl)("sheet-registry-repo (integration)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl });
    await runMigrations(pool, getDefaultMigrationsDir());
    await pool.query("DELETE FROM sheet_registry");
  });

  afterEach(async () => {
    await pool.end();
  });

  it("returns undefined when no entry exists", async () => {
    await expect(getBySlug(pool, "clients")).resolves.toBeUndefined();
  });

  it("round-trips a fully-specified entry", async () => {
    await upsert(pool, {
      slug: "clients",
      spreadsheetId: "spreadsheet-1",
      description: "Client roster",
      access: "readwrite",
      valueInputOption: "RAW",
    });

    const fetched = await getBySlug(pool, "clients");

    expect(fetched?.slug).toBe("clients");
    expect(fetched?.spreadsheetId).toBe("spreadsheet-1");
    expect(fetched?.description).toBe("Client roster");
    expect(fetched?.access).toBe("readwrite");
    expect(fetched?.valueInputOption).toBe("RAW");
  });

  it("a minimal upsert with no access/valueInputOption/description supplied round-trips the migration's own defaults", async () => {
    await upsert(pool, { slug: "appointments", spreadsheetId: "spreadsheet-2" });

    const fetched = await getBySlug(pool, "appointments");

    expect(fetched?.description).toBe("");
    expect(fetched?.access).toBe("read");
    expect(fetched?.valueInputOption).toBe("USER_ENTERED");
  });

  it("upserting twice for the same slug overwrites every field, not just updated_at", async () => {
    await upsert(pool, {
      slug: "clients",
      spreadsheetId: "spreadsheet-1",
      description: "First",
      access: "read",
      valueInputOption: "RAW",
    });
    const before = await pool.query<{ created_at: Date; updated_at: Date }>(
      "SELECT created_at, updated_at FROM sheet_registry WHERE slug = $1",
      ["clients"],
    );

    // now() is transaction-start time in Postgres, so back-to-back upserts in
    // the same millisecond can otherwise report an identical updated_at.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await upsert(pool, {
      slug: "clients",
      spreadsheetId: "spreadsheet-2",
      description: "Second",
      access: "readwrite",
      valueInputOption: "USER_ENTERED",
    });

    const fetched = await getBySlug(pool, "clients");
    expect(fetched?.spreadsheetId).toBe("spreadsheet-2");
    expect(fetched?.description).toBe("Second");
    expect(fetched?.access).toBe("readwrite");
    expect(fetched?.valueInputOption).toBe("USER_ENTERED");

    const after = await pool.query<{ created_at: Date; updated_at: Date }>(
      "SELECT created_at, updated_at FROM sheet_registry WHERE slug = $1",
      ["clients"],
    );
    expect(after.rows[0]?.created_at).toEqual(before.rows[0]?.created_at);
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );

    const countResult = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM sheet_registry WHERE slug = $1",
      ["clients"],
    );
    expect(countResult.rows[0]?.count).toBe("1");
  });

  it("re-registering a slug with fields omitted resets them to the migration defaults, not the prior values", async () => {
    await upsert(pool, {
      slug: "clients",
      spreadsheetId: "spreadsheet-1",
      description: "First",
      access: "readwrite",
      valueInputOption: "RAW",
    });

    await upsert(pool, { slug: "clients", spreadsheetId: "spreadsheet-1" });

    const fetched = await getBySlug(pool, "clients");
    expect(fetched?.description).toBe("");
    expect(fetched?.access).toBe("read");
    expect(fetched?.valueInputOption).toBe("USER_ENTERED");
  });

  it("listAll returns [] on an empty table", async () => {
    await expect(listAll(pool)).resolves.toEqual([]);
  });

  it("listAll returns every row", async () => {
    await upsert(pool, { slug: "clients", spreadsheetId: "spreadsheet-1" });
    await upsert(pool, { slug: "appointments", spreadsheetId: "spreadsheet-2" });

    const entries = await listAll(pool);

    expect(entries.map((entry) => entry.slug).sort()).toEqual(["appointments", "clients"]);
  });

  it("remove deletes the row", async () => {
    await upsert(pool, { slug: "clients", spreadsheetId: "spreadsheet-1" });

    await remove(pool, "clients");

    await expect(getBySlug(pool, "clients")).resolves.toBeUndefined();
  });

  it("remove is idempotent on a slug that was never registered", async () => {
    await expect(remove(pool, "nonexistent")).resolves.toBeUndefined();
  });
});
