import { describe, expect, it } from "vitest";
import { detectValueInputConsequence } from "../value-input-consequence";

describe("detectValueInputConsequence", () => {
  it("RAW short-circuits to null even when a cell would otherwise flag under USER_ENTERED", () => {
    const values = [["=A1+1", "1990-05-12", "0123"]];
    expect(detectValueInputConsequence(values, "RAW")).toBeNull();
  });

  it("RAW never scans a single cell — a row that throws when read still returns null immediately, proving the short-circuit happens before any per-cell scan", () => {
    const explodingRow = new Proxy([] as unknown[], {
      get() {
        throw new Error("bug: RAW must never scan cells");
      },
    });
    const values = [explodingRow] as unknown[][];

    expect(() => detectValueInputConsequence(values, "RAW")).not.toThrow();
    expect(detectValueInputConsequence(values, "RAW")).toBeNull();
  });

  it("returns null for a USER_ENTERED write with no flagged values", () => {
    expect(detectValueInputConsequence([["Jane", "555-0100"]], "USER_ENTERED")).toBeNull();
  });

  it("returns null for an empty values array", () => {
    expect(detectValueInputConsequence([], "USER_ENTERED")).toBeNull();
  });

  it('matches the plan\'s literal example for a date-like value: "1990-05-12" se guardará como fecha.', () => {
    expect(detectValueInputConsequence([["Test Uno", "1990-05-12"]], "USER_ENTERED")).toBe(
      '"1990-05-12" se guardará como fecha.',
    );
  });

  it("flags a DD/MM/YYYY-shaped date", () => {
    expect(detectValueInputConsequence([["31/12/2026"]], "USER_ENTERED")).toBe(
      '"31/12/2026" se guardará como fecha.',
    );
  });

  it("flags a purely numeric string with a leading zero", () => {
    expect(detectValueInputConsequence([["0123"]], "USER_ENTERED")).toBe(
      '"0123" se guardará como número.',
    );
  });

  it("does not flag a bare zero or a plain decimal that happens to start with 0 — neither loses anything on parse", () => {
    expect(detectValueInputConsequence([["0"]], "USER_ENTERED")).toBeNull();
    expect(detectValueInputConsequence([["0.5"]], "USER_ENTERED")).toBeNull();
  });

  it("flags a thousands/decimal-separator-formatted number", () => {
    expect(detectValueInputConsequence([["12,345"]], "USER_ENTERED")).toBe(
      '"12,345" se guardará como número.',
    );
    expect(detectValueInputConsequence([["1.234,56"]], "USER_ENTERED")).toBe(
      '"1.234,56" se guardará como número.',
    );
  });

  it('matches the plan\'s literal example for a leading "=": "=A1+1" se guardará como fórmula.', () => {
    expect(detectValueInputConsequence([["=A1+1"]], "USER_ENTERED")).toBe(
      '"=A1+1" se guardará como fórmula.',
    );
  });

  it('flags a leading "+", per the plan\'s "=A1+1"-style formula example generalized to the other trigger characters (settled decision 19)', () => {
    expect(detectValueInputConsequence([["+1-555-0100"]], "USER_ENTERED")).toBe(
      '"+1-555-0100" se guardará como fórmula.',
    );
  });

  it('flags a leading "-" as a formula risk, per settled decision 19', () => {
    expect(detectValueInputConsequence([["-5+3"]], "USER_ENTERED")).toBe(
      '"-5+3" se guardará como fórmula.',
    );
  });

  it('flags a leading "@" as a formula risk, per settled decision 19', () => {
    expect(detectValueInputConsequence([["@mention"]], "USER_ENTERED")).toBe(
      '"@mention" se guardará como fórmula.',
    );
  });

  it('the leading-character rule wins even when the same cell would also match another heuristic (settled decision 19: checked "regardless of the other heuristics")', () => {
    // Also date-shaped (DD/MM/YYYY) after the leading character, but the
    // leading "=" is decisive per settled decision 19.
    expect(detectValueInputConsequence([["=31/12/2026"]], "USER_ENTERED")).toBe(
      '"=31/12/2026" se guardará como fórmula.',
    );
  });

  it("deliberately ambiguous case, flagged anyway: a leading-zero string that reads like a fixed code a human wouldn't expect Sheets to touch " +
    "(e.g. a toll-free prefix) still trips the leading-zero heuristic. This is the accepted over-flag trade-off, not an oversight: a false " +
    "positive costs one redundant sentence in the prompt, while a false negative here would mean the code silently loses its leading zero " +
    "with nothing in the approval prompt warning the human beforehand.", () => {
    expect(detectValueInputConsequence([["0800"]], "USER_ENTERED")).toBe(
      '"0800" se guardará como número.',
    );
  });

  it("names the first flagged cell in row-major order when several cells are flagged", () => {
    const values = [
      ["ordinary", "text"],
      ["0123", "=A1+1"],
    ];
    expect(detectValueInputConsequence(values, "USER_ENTERED")).toBe(
      '"0123" se guardará como número.',
    );
  });

  it("collapses whitespace runs (including newlines/tabs) in the flagged value before quoting it, mirroring formatRowPreview's newline-injection guard so a crafted cell can't forge extra prompt lines", () => {
    expect(detectValueInputConsequence([["=A1\n+1\t+2"]], "USER_ENTERED")).toBe(
      '"=A1 +1 +2" se guardará como fórmula.',
    );
  });

  it("caps the quoted value's length so one oversized cell can't blow up the prompt", () => {
    const longFormula = `=${"A".repeat(100)}`;
    const result = detectValueInputConsequence([[longFormula]], "USER_ENTERED");
    expect(result).toBe(`"${longFormula.slice(0, 60)}…" se guardará como fórmula.`);
  });
});
