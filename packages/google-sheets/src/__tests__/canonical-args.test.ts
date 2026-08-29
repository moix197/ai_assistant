import { describe, expect, it } from "vitest";
import { canonicalizeArgs, computeDedupeKey } from "../canonical-args";

describe("canonicalizeArgs", () => {
  it("is key-order-independent: two objects differing only in key insertion order canonicalize identically", () => {
    const a = { mode: "append", sheet: "clients", values: [["Jane", "555-0100"]] };
    const b = { values: [["Jane", "555-0100"]], sheet: "clients", mode: "append" };

    expect(canonicalizeArgs(a)).toBe(canonicalizeArgs(b));
  });

  it("is key-order-independent through nested objects too", () => {
    const a = { outer: { z: 1, a: 2 }, top: "x" };
    const b = { top: "x", outer: { a: 2, z: 1 } };

    expect(canonicalizeArgs(a)).toBe(canonicalizeArgs(b));
  });

  it("preserves array element order — order is meaningful there, unlike object keys", () => {
    const a = {
      values: [
        ["Jane", "555-0100"],
        ["Jo", "555-0200"],
      ],
    };
    const b = {
      values: [
        ["Jo", "555-0200"],
        ["Jane", "555-0100"],
      ],
    };

    expect(canonicalizeArgs(a)).not.toBe(canonicalizeArgs(b));
  });

  it("still differs for genuinely different values", () => {
    const a = { sheet: "clients" };
    const b = { sheet: "appointments" };

    expect(canonicalizeArgs(a)).not.toBe(canonicalizeArgs(b));
  });
});

describe("computeDedupeKey", () => {
  const base = {
    channel: "telegram",
    channelUserId: "111",
    turnId: "turn-1",
    tool: "sheets_write",
    canonicalArgsJson: canonicalizeArgs({ mode: "append", sheet: "clients" }),
  };

  it("is deterministic for identical parts", () => {
    expect(computeDedupeKey(base)).toBe(computeDedupeKey({ ...base }));
  });

  it("differs when only turnId differs — proves turnId actually participates in the hash (settled decision 12)", () => {
    expect(computeDedupeKey(base)).not.toBe(computeDedupeKey({ ...base, turnId: "turn-2" }));
  });

  it("differs when only the canonical args differ", () => {
    const otherArgs = canonicalizeArgs({ mode: "append", sheet: "appointments" });
    expect(computeDedupeKey(base)).not.toBe(
      computeDedupeKey({ ...base, canonicalArgsJson: otherArgs }),
    );
  });
});
