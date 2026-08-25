import { describe, expect, it } from "vitest";
import { isAllowed, parseAllowlist } from "../allowlist";

describe("parseAllowlist", () => {
  it("parses a comma-separated list of numeric ids", () => {
    expect(parseAllowlist("123,456,789")).toEqual(new Set([123, 456, 789]));
  });

  it("trims whitespace around entries", () => {
    expect(parseAllowlist(" 123 , 456 ")).toEqual(new Set([123, 456]));
  });

  it("returns an empty set for an empty string", () => {
    expect(parseAllowlist("")).toEqual(new Set());
  });

  it("returns an empty set for a whitespace-only string", () => {
    expect(parseAllowlist("   ")).toEqual(new Set());
  });

  it("parses a single id", () => {
    expect(parseAllowlist("42")).toEqual(new Set([42]));
  });
});

describe("isAllowed", () => {
  it("returns true for an id in the allowlist", () => {
    expect(isAllowed(123, new Set([123, 456]))).toBe(true);
  });

  it("returns false for an id not in the allowlist", () => {
    expect(isAllowed(999, new Set([123, 456]))).toBe(false);
  });

  it("rejects everyone when the allowlist is empty", () => {
    const empty = parseAllowlist("");
    expect(isAllowed(123, empty)).toBe(false);
    expect(isAllowed(0, empty)).toBe(false);
  });
});
