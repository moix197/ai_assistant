import { type SheetRegistryEntry, sheetRegistryEntrySchema } from "@hermes/core";
import type { Pool } from "pg";
import { parseValidatedJson } from "./validate-row";

export type { SheetRegistryEntry };

interface SheetRegistryRow {
  slug: string;
  spreadsheet_id: string;
  description: string;
  access: string;
  value_input_option: string;
  created_at: Date;
  updated_at: Date;
}

function toSheetRegistryEntry(row: SheetRegistryRow): SheetRegistryEntry {
  const candidate = {
    slug: row.slug,
    spreadsheetId: row.spreadsheet_id,
    description: row.description,
    access: row.access,
    valueInputOption: row.value_input_option,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return parseValidatedJson(sheetRegistryEntrySchema, candidate, "sheet_registry");
}

export async function getBySlug(pool: Pool, slug: string): Promise<SheetRegistryEntry | undefined> {
  const result = await pool.query<SheetRegistryRow>(
    "SELECT * FROM sheet_registry WHERE slug = $1",
    [slug],
  );
  const row = result.rows[0];
  return row ? toSheetRegistryEntry(row) : undefined;
}

export async function listAll(pool: Pool): Promise<SheetRegistryEntry[]> {
  const result = await pool.query<SheetRegistryRow>("SELECT * FROM sheet_registry ORDER BY slug");
  return result.rows.map(toSheetRegistryEntry);
}

/**
 * `description`/`access`/`valueInputOption` are optional on purpose: when a
 * caller omits one, the SQL below emits the literal `DEFAULT` keyword for
 * that column instead of a bound parameter, so the migration's own
 * `DEFAULT`/`CHECK` is what actually resolves the value — not a
 * JS-side fallback that would let the default silently drift out of sync
 * with the schema. See `.ai/patterns/db-backed-tool-config.md`.
 */
export interface UpsertSheetRegistryEntryInput {
  slug: string;
  spreadsheetId: string;
  description?: string;
  access?: SheetRegistryEntry["access"];
  valueInputOption?: SheetRegistryEntry["valueInputOption"];
}

/**
 * `INSERT ... ON CONFLICT (slug) DO UPDATE` — the second deliberate
 * `DO UPDATE` exception in this codebase (`google-account-repo.ts`'s
 * `upsertAccount` is the first), justified the same way: re-registering an
 * existing slug must overwrite every field, not silently keep stale config.
 * An omitted optional field on a fresh insert resolves to the migration's
 * default; an omitted optional field on a re-registration resolves to that
 * same default too (not "keep the old value") — `EXCLUDED` always reflects
 * whatever the INSERT actually resolved, DEFAULT included.
 */
export async function upsert(pool: Pool, entry: UpsertSheetRegistryEntryInput): Promise<void> {
  const columns = ["slug", "spreadsheet_id"];
  const valueExprs = ["$1", "$2"];
  const params: unknown[] = [entry.slug, entry.spreadsheetId];

  function addOptional(column: string, value: string | undefined): void {
    columns.push(column);
    if (value === undefined) {
      valueExprs.push("DEFAULT");
    } else {
      params.push(value);
      valueExprs.push(`$${params.length}`);
    }
  }

  addOptional("description", entry.description);
  addOptional("access", entry.access);
  addOptional("value_input_option", entry.valueInputOption);

  await pool.query(
    `INSERT INTO sheet_registry (${columns.join(", ")}, updated_at)
     VALUES (${valueExprs.join(", ")}, now())
     ON CONFLICT (slug) DO UPDATE SET
       spreadsheet_id = EXCLUDED.spreadsheet_id,
       description = EXCLUDED.description,
       access = EXCLUDED.access,
       value_input_option = EXCLUDED.value_input_option,
       updated_at = now()`,
    params,
  );
}

/** A missing slug is a no-op, not an error — the same idempotent-removal posture `/disconnect` uses. */
export async function remove(pool: Pool, slug: string): Promise<void> {
  await pool.query("DELETE FROM sheet_registry WHERE slug = $1", [slug]);
}
