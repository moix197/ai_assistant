import type { ValueInputOption } from "./sheets-client";

/**
 * Tool-side detector for `sheets_write`'s approval-prompt consequence
 * sentence (`06-legible-approvals-bounded-reads` Phase 6) — the last piece
 * of the plan's Tier 1 prompt. `RAW` never reinterprets a cell's content, so
 * it short-circuits to `null` before any per-cell scan even starts. Under
 * `USER_ENTERED`, Sheets parses every cell the way a human typing it into
 * the UI would, which can silently reinterpret a value the model sent as
 * plain text: a leading `=`/`+`/`-`/`@` becomes a formula, a date-shaped
 * string becomes a date, and a numeric-looking string can lose a leading
 * zero or have its thousands/decimal separators reinterpreted. This
 * detector names the first cell (in row-major order) that triggers any of
 * those heuristics, so the approval prompt can warn about it before the
 * human taps Aprobar.
 *
 * Tuned to over-flag on purpose, per settled decision 19 (the leading-
 * character rule) and the plan's own framing more broadly: a false positive
 * here costs one redundant sentence in the prompt; a false negative risks
 * silent data corruption the human never had a chance to catch. See
 * `__tests__/value-input-consequence.test.ts`'s "ambiguous but flagged
 * anyway" case for a worked example of that trade-off.
 */

/** Caps the quoted value embedded in the prompt so one oversized cell can't blow it up — mirrors `sheets-write.ts`'s `ROW_PREVIEW_CHAR_LIMIT` in spirit, sized smaller since only one value is quoted here, not a whole joined row. */
const MAX_QUOTED_VALUE_CHARS = 60;

/** Always a formula risk when leading, regardless of the other heuristics (settled decision 19). */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

const ISO_DATE_PATTERN = /^\d{4}-\d{1,2}-\d{1,2}$/;
const DMY_DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
/** e.g. "0123" — a purely numeric string with a leading zero, which `USER_ENTERED` drops on parse. Excludes a bare "0" and a decimal like "0.5" (no extra digit immediately follows the leading zero), neither of which loses anything on parse. */
const LEADING_ZERO_NUMBER_PATTERN = /^0\d+(\.\d+)?$/;
/** e.g. "12,345", "1.234,56" — a numeric string with a thousands and/or decimal separator, whose grouping/format Sheets can reinterpret differently than the literal characters sent. */
const SEPARATOR_NUMBER_PATTERN = /^\d{1,3}([.,]\d{3})+([.,]\d+)?$/;

type Consequence = "formula" | "fecha" | "numero";

/**
 * A leading `=`/`+`/`-`/`@` is checked first, and wins over the other
 * heuristics even when the same cell would also match one of them (settled
 * decision 19) — Sheets' own parser treats the leading character as
 * decisive, so the detector mirrors that rather than picking whichever
 * heuristic happens to run first.
 */
function detectsFormulaTrigger(cellText: string): boolean {
  return FORMULA_TRIGGER_CHARS.has(cellText.charAt(0));
}

function looksLikeDate(cellText: string): boolean {
  return ISO_DATE_PATTERN.test(cellText) || DMY_DATE_PATTERN.test(cellText);
}

function looksLikeReformattableNumber(cellText: string): boolean {
  return LEADING_ZERO_NUMBER_PATTERN.test(cellText) || SEPARATOR_NUMBER_PATTERN.test(cellText);
}

function classifyCell(cellText: string): Consequence | null {
  if (detectsFormulaTrigger(cellText)) return "formula";
  if (looksLikeDate(cellText)) return "fecha";
  if (looksLikeReformattableNumber(cellText)) return "numero";
  return null;
}

/**
 * Collapses whitespace runs (mirrors `sheets-write.ts`'s `formatRowPreview`
 * — the identical class of bug: an embedded newline in a cell could
 * otherwise inject extra lines into the rendered approval prompt) and then
 * caps the quoted value's length, so a single enormous cell can't blow up
 * the prompt either.
 */
function formatQuotedValue(cellText: string): string {
  const collapsed = cellText.replace(/\s+/g, " ");
  return collapsed.length > MAX_QUOTED_VALUE_CHARS
    ? `${collapsed.slice(0, MAX_QUOTED_VALUE_CHARS)}…`
    : collapsed;
}

function buildSentence(consequence: Consequence, quotedValue: string): string {
  if (consequence === "formula") return `"${quotedValue}" se guardará como fórmula.`;
  if (consequence === "fecha") return `"${quotedValue}" se guardará como fecha.`;
  return `"${quotedValue}" se guardará como número.`;
}

/**
 * Returns the approval-prompt consequence sentence for the first flagged
 * cell in `values` (row-major order — the same order the prompt's row
 * preview already scans), or `null` when nothing is flagged, including
 * always, immediately, for `RAW`.
 */
export function detectValueInputConsequence(
  values: unknown[][],
  effectiveValueInputOption: ValueInputOption,
): string | null {
  if (effectiveValueInputOption === "RAW") return null;

  for (const row of values) {
    for (const cell of row) {
      const cellText = String(cell);
      const consequence = classifyCell(cellText);
      if (consequence) {
        return buildSentence(consequence, formatQuotedValue(cellText));
      }
    }
  }
  return null;
}
