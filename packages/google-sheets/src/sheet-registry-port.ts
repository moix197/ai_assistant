import type { SheetRegistryEntry } from "@hermes/core";

/**
 * The row shape itself lives in `@hermes/core` (`google-types.ts`,
 * `05-google-sheets` Phase 3) and is re-exported both here and by
 * `@hermes/store` — the same arrangement `GoogleAccount` already uses
 * between `@hermes/google-auth` and `@hermes/store`, adopted here from the
 * start rather than fixed up after the fact (see
 * `plans/05-google-sheets.md`'s Dependencies & Risks).
 */
export type { SheetRegistryEntry };

/**
 * The injected persistence port — `packages/google-sheets` never imports
 * `@hermes/store` directly, the same boundary `packages/google-auth`'s
 * `GoogleAccountRepo` and `packages/agent`'s `ThreadRepo` already follow.
 * `apps/hermes/src/store/build-sheet-registry-repo.ts` binds this to
 * `@hermes/store`'s `getSheetRegistryEntryBySlug`/`listSheetRegistryEntries`
 * free functions — no caching, straight through to the pool on every call
 * (settled decision 5): a sheet's `access`/`value_input_option` can change
 * between two tool calls in the same conversation, and a stale read would
 * let a write-access downgrade go unenforced until the next boot.
 */
export interface SheetRegistryPort {
  getBySlug(slug: string): Promise<SheetRegistryEntry | undefined>;
  listAll(): Promise<SheetRegistryEntry[]>;
}
