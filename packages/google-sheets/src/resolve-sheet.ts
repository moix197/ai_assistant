import type { SheetRegistryEntry } from "@hermes/core";
import type { SheetRegistryPort } from "./sheet-registry-port";

export interface UnknownSheetResult {
  ok: false;
  reason: "unknown_sheet";
  /** Every currently-registered slug, so the model can relay valid options instead of just "no". Empty when the registry itself is empty — not an error, see below. */
  available: string[];
}

export type ResolveSheetResult = { ok: true; entry: SheetRegistryEntry } | UnknownSheetResult;

/**
 * Looks up `sheet` (a slug) against the *live* registry — `getBySlug` first,
 * `listAll` only on the unknown-slug path (a known slug never pays for the
 * extra query). Shared by every Sheets tool so the unknown-slug shape,
 * including the empty-registry case (`listAll()` returning `[]` is a normal
 * "nothing registered yet" result, not an error), is defined exactly once —
 * see `sheets-inspect.ts`/`sheets-read.ts`, which both return this result
 * directly on the `ok: false` branch rather than re-deriving it.
 */
export async function resolveSheet(
  registry: SheetRegistryPort,
  sheet: string,
): Promise<ResolveSheetResult> {
  const entry = await registry.getBySlug(sheet);
  if (entry) return { ok: true, entry };

  const all = await registry.listAll();
  return { ok: false, reason: "unknown_sheet", available: all.map((candidate) => candidate.slug) };
}
