import { describe, expect, it } from "vitest";
import { deriveEventId } from "../deterministic-event-id";

describe("deriveEventId", () => {
  it("is deterministic: the same (turnId, args) yields the same id", () => {
    const args = { summary: "Lunch", startUtc: "2026-09-08T16:00:00.000Z" };

    expect(deriveEventId("turn-1", args)).toBe(deriveEventId("turn-1", { ...args }));
  });

  it("is key-order-independent in canonicalArgs — delegates to sha256HexOfCanonicalJson", () => {
    const a = { summary: "Lunch", startUtc: "2026-09-08T16:00:00.000Z" };
    const b = { startUtc: "2026-09-08T16:00:00.000Z", summary: "Lunch" };

    expect(deriveEventId("turn-1", a)).toBe(deriveEventId("turn-1", b));
  });

  it("differs for a different turnId, same args", () => {
    const args = { summary: "Lunch" };

    expect(deriveEventId("turn-1", args)).not.toBe(deriveEventId("turn-2", args));
  });

  it("differs for different args, same turnId", () => {
    expect(deriveEventId("turn-1", { summary: "Lunch" })).not.toBe(
      deriveEventId("turn-1", { summary: "Dinner" }),
    );
  });

  it("output is a lowercase base32hex-compatible string within Calendar's 5-1024 length bound", () => {
    const id = deriveEventId("turn-1", { summary: "Lunch" });

    expect(id).toMatch(/^[0-9a-v]+$/);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });
});
