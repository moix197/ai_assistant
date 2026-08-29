/**
 * Shared bound for `sheets_read` (Phase 1), `sheets_inspect` (Phase 2), and
 * the update-mode `replaced` snapshot (Phase 7) — package-internal, not
 * env-configurable, so every caller of `truncateBySize` gets the same caps.
 */
export const MAX_CELLS = 500;
export const MAX_VALUE_CHARS = 4_000;

export interface TruncateBySizeCaps {
  maxCells: number;
  maxChars: number;
}

export interface TruncateBySizeResult<T> {
  items: T[];
  truncated: boolean;
  returnedCount: number;
  totalCount: number;
}

/**
 * Accumulates `items` in order, stopping *before* a would-be-added item
 * would push either running total (`cells` or `chars`) over its cap —
 * except the first item is always kept, so a single oversized item (a huge
 * row, a huge tab) is still returned whole rather than split.
 */
export function truncateBySize<T>(
  items: T[],
  measure: (item: T) => { cells: number; chars: number },
  caps: TruncateBySizeCaps = { maxCells: MAX_CELLS, maxChars: MAX_VALUE_CHARS },
): TruncateBySizeResult<T> {
  const kept: T[] = [];
  let cells = 0;
  let chars = 0;
  let truncated = false;

  for (const item of items) {
    const size = measure(item);
    const wouldExceed = cells + size.cells > caps.maxCells || chars + size.chars > caps.maxChars;
    if (wouldExceed) {
      // Always keep at least one item — a single oversized row/tab is still
      // returned whole, never split.
      if (kept.length === 0) {
        kept.push(item);
        cells += size.cells;
        chars += size.chars;
      }
      truncated = true;
      break;
    }

    kept.push(item);
    cells += size.cells;
    chars += size.chars;
  }

  return {
    items: kept,
    truncated,
    returnedCount: kept.length,
    totalCount: items.length,
  };
}

/**
 * The `truncateBySize` `measure` callback shared by every row-shaped caller
 * — `sheets_read`, `sheets_inspect`, and the update-mode `replaced` snapshot
 * (`06-legible-approvals-bounded-reads` Phase 7) all cap on the same
 * per-row `{ cells, chars }` shape, so this is extracted once here rather
 * than duplicated at each call site (CLAUDE.md: extract on second use).
 */
export function measureRow(row: unknown[]): { cells: number; chars: number } {
  return { cells: row.length, chars: JSON.stringify(row).length };
}

/**
 * Collapses whitespace runs (including newlines/tabs) to a single space,
 * then truncates to `limit` chars with a trailing "…" if it still exceeds —
 * shared by every approval-prompt preview that needs to cap an arbitrary
 * string's length. Collapsing whitespace before truncating is load-bearing:
 * an embedded newline in a cell would otherwise inject extra lines into the
 * rendered approval prompt. Used by `tools/sheets-write.ts`'s row preview and
 * `value-input-consequence.ts`'s quoted cell value.
 */
export function truncateForPrompt(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}
