import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys — arrays keep their given order (order is
 * meaningful there), only object keys are reordered — so two logically
 * identical values that differ only in key insertion order hash
 * identically. Extracted from `packages/google-sheets/src/canonical-args.ts`'s
 * `sortKeysDeep` (`google-sheets` itself is left untouched — see
 * `.ai/decisions/calendar-event-idempotency.md`).
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 hex digest of `value`'s canonical (key-order-independent) JSON
 * form. Shared, additive `@hermes/core` export so a peer package with no
 * import path to `google-sheets` (e.g. `google-calendar`'s
 * `deriveEventId`) can reuse the same canonicalize-then-hash algorithm
 * instead of writing a second one.
 */
export function sha256HexOfCanonicalJson(value: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(value));
  return createHash("sha256").update(canonical).digest("hex");
}
