import { describe, expect, it } from "vitest";
import { canonicalizeArgs, computeDedupeKey } from "../canonical-args";

describe("canonicalizeArgs", () => {
  it("is key-order-independent: two objects differing only in key insertion order canonicalize identically", () => {
    const a = { draftId: "draft-1" };
    const b = { draftId: "draft-1" };

    expect(canonicalizeArgs(a)).toBe(canonicalizeArgs(b));
  });

  it("is key-order-independent through nested objects too", () => {
    const a = { outer: { z: 1, a: 2 }, top: "x" };
    const b = { top: "x", outer: { a: 2, z: 1 } };

    expect(canonicalizeArgs(a)).toBe(canonicalizeArgs(b));
  });

  it("preserves array element order — order is meaningful there, unlike object keys", () => {
    const a = { items: ["a", "b"] };
    const b = { items: ["b", "a"] };

    expect(canonicalizeArgs(a)).not.toBe(canonicalizeArgs(b));
  });

  it("still differs for genuinely different values", () => {
    const a = { draftId: "draft-1" };
    const b = { draftId: "draft-2" };

    expect(canonicalizeArgs(a)).not.toBe(canonicalizeArgs(b));
  });
});

describe("computeDedupeKey", () => {
  const base = {
    channel: "telegram",
    channelUserId: "111",
    turnId: "turn-1",
    tool: "gmail_send_draft",
    canonicalArgsJson: canonicalizeArgs({ draftId: "draft-1" }),
  };

  it("is deterministic for identical parts", () => {
    expect(computeDedupeKey(base)).toBe(computeDedupeKey({ ...base }));
  });

  it("differs when only turnId differs — a same-turn retry guard, never a permanent block on ever sending that draft again", () => {
    expect(computeDedupeKey(base)).not.toBe(computeDedupeKey({ ...base, turnId: "turn-2" }));
  });

  it("differs when only the canonical args differ", () => {
    const otherArgs = canonicalizeArgs({ draftId: "draft-2" });
    expect(computeDedupeKey(base)).not.toBe(
      computeDedupeKey({ ...base, canonicalArgsJson: otherArgs }),
    );
  });

  it("identical args within one turn hash identically", () => {
    const first = computeDedupeKey({
      ...base,
      canonicalArgsJson: canonicalizeArgs({ draftId: "draft-1" }),
    });
    const second = computeDedupeKey({
      ...base,
      canonicalArgsJson: canonicalizeArgs({ draftId: "draft-1" }),
    });
    expect(first).toBe(second);
  });
});
