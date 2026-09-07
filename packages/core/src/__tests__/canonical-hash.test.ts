import { describe, expect, it } from "vitest";
import { sha256HexOfCanonicalJson } from "../canonical-hash";

describe("sha256HexOfCanonicalJson", () => {
  it("is key-order-independent: two objects differing only in key insertion order hash identically", () => {
    const a = { summary: "Lunch", startUtc: "2026-09-08T16:00:00.000Z" };
    const b = { startUtc: "2026-09-08T16:00:00.000Z", summary: "Lunch" };

    expect(sha256HexOfCanonicalJson(a)).toBe(sha256HexOfCanonicalJson(b));
  });

  it("is key-order-independent through nested objects too", () => {
    const a = { outer: { z: 1, a: 2 }, top: "x" };
    const b = { top: "x", outer: { a: 2, z: 1 } };

    expect(sha256HexOfCanonicalJson(a)).toBe(sha256HexOfCanonicalJson(b));
  });

  it("is stable across repeated calls for the same value", () => {
    const value = { turnId: "turn-1", args: { summary: "Lunch" } };

    expect(sha256HexOfCanonicalJson(value)).toBe(sha256HexOfCanonicalJson(value));
  });

  it("produces a lowercase hex string", () => {
    const digest = sha256HexOfCanonicalJson({ a: 1 });

    expect(digest).toMatch(/^[0-9a-f]+$/);
    expect(digest).toHaveLength(64);
  });

  it("differs for genuinely different values", () => {
    const a = sha256HexOfCanonicalJson({ summary: "Lunch" });
    const b = sha256HexOfCanonicalJson({ summary: "Dinner" });

    expect(a).not.toBe(b);
  });
});
