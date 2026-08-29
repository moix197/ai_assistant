import type { SheetRegistryPort } from "@hermes/google-sheets";
import { type Pool, getSheetRegistryEntryBySlug, listSheetRegistryEntries } from "@hermes/store";

/**
 * Wires `@hermes/google-sheets`'s injected `SheetRegistryPort` to
 * `@hermes/store`'s real Postgres-backed functions — the same shape
 * `build-thread-repo.ts`/`build-google-account-repo.ts` use. No caching, no
 * boot-time snapshot: both methods call straight through to `pool` on every
 * invocation, so a registry mutation between two tool calls is seen by the
 * second (settled decision 5).
 */
export function buildSheetRegistryRepo(pool: Pool): SheetRegistryPort {
  return {
    getBySlug: (slug: string) => getSheetRegistryEntryBySlug(pool, slug),
    listAll: () => listSheetRegistryEntries(pool),
  };
}
