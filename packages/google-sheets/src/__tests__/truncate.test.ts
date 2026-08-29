import { describe, expect, it } from "vitest";
import { MAX_CELLS, MAX_VALUE_CHARS, truncateBySize } from "../truncate";

function rowMeasure(row: unknown[]) {
  return { cells: row.length, chars: JSON.stringify(row).length };
}

describe("truncateBySize", () => {
  it("keeps everything when under both caps", () => {
    const items = [
      ["a", "b"],
      ["c", "d"],
    ];
    const result = truncateBySize(items, rowMeasure);
    expect(result).toEqual({
      items,
      truncated: false,
      returnedCount: 2,
      totalCount: 2,
    });
  });

  it("truncates on cell count alone", () => {
    // Each row has MAX_CELLS/2 + 1 cells, each cell tiny — two rows exceed
    // MAX_CELLS but stay well under MAX_VALUE_CHARS.
    const wideRow = Array.from({ length: Math.floor(MAX_CELLS / 2) + 1 }, () => "x");
    const items = [wideRow, wideRow];
    const result = truncateBySize(items, rowMeasure);
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.items).toEqual([wideRow]);
  });

  it("truncates on char count alone", () => {
    // Two rows, few cells each but large strings — trips maxChars long
    // before maxCells.
    const bigString = "x".repeat(Math.floor(MAX_VALUE_CHARS / 2) + 10);
    const items = [
      ["a", bigString],
      ["b", bigString],
    ];
    const result = truncateBySize(items, rowMeasure);
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });

  it("stops as soon as either cap would be tripped, whichever comes first", () => {
    // First row trips maxCells; second row (if it were reached) would trip
    // maxChars instead — either way, truncation must happen at row 1.
    const wideRow = Array.from({ length: MAX_CELLS + 1 }, () => "x");
    const bigRow = ["x".repeat(MAX_VALUE_CHARS + 1)];
    const result = truncateBySize([wideRow, bigRow], rowMeasure);
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
  });

  it("always keeps at least one item — a single oversized item is returned whole, never split", () => {
    const hugeRow = Array.from({ length: MAX_CELLS * 5 }, (_, i) => `cell-${i}`);
    const result = truncateBySize([hugeRow], rowMeasure);
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.items).toEqual([hugeRow]);
  });

  it("drops a second row, however small, once the first oversized row already fills the caps", () => {
    const hugeRow = Array.from({ length: MAX_CELLS * 5 }, (_, i) => `cell-${i}`);
    const tinyRow = ["x"];
    const result = truncateBySize([hugeRow, tinyRow], rowMeasure);
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.items).toEqual([hugeRow]);
  });

  it("returns untruncated, zero-count result for an empty input array", () => {
    const result = truncateBySize([], rowMeasure);
    expect(result).toEqual({
      items: [],
      truncated: false,
      returnedCount: 0,
      totalCount: 0,
    });
  });

  it("stays untruncated exactly at the cap boundary", () => {
    // A single row landing exactly on MAX_CELLS should not trip truncation.
    const boundaryRow = Array.from({ length: MAX_CELLS }, () => "x");
    const result = truncateBySize([boundaryRow], rowMeasure);
    expect(result.truncated).toBe(false);
    expect(result.returnedCount).toBe(1);
  });
});
