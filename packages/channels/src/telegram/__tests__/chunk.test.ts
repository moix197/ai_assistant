import { describe, expect, it } from "vitest";
import { chunkText } from "../chunk";

describe("chunkText", () => {
  it("returns a single part when the text is under the limit", () => {
    const text = "hello world";
    expect(chunkText(text, 4096)).toEqual([text]);
  });

  it("splits at the last whitespace before the limit", () => {
    const text = `${"a".repeat(10)} ${"b".repeat(10)}`;
    const parts = chunkText(text, 15);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(15);
    }
    expect(parts.join("")).toBe(text);
  });

  it("hard-cuts when no whitespace exists in range", () => {
    const text = "a".repeat(30);
    const parts = chunkText(text, 10);

    expect(parts).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(10)]);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(10);
    }
  });

  it("rejoins to the original text for a long, mixed-whitespace input", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const parts = chunkText(text, 4096);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    expect(parts.join("")).toBe(text);
  });

  it("uses 4096 as the default maxLen", () => {
    const text = "x".repeat(5000);
    const parts = chunkText(text);

    expect(parts.length).toBe(2);
    expect(parts.at(0)?.length).toBe(4096);
  });
});
