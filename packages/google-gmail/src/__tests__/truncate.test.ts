import { describe, expect, it } from "vitest";
import { measureMessage, truncateBySize } from "../truncate";

function messageMeasure(chars: number) {
  return measureMessage(chars);
}

describe("truncateBySize", () => {
  it("keeps everything when under both caps", () => {
    const items = [1, 2, 3];
    const result = truncateBySize(items, () => messageMeasure(10), {
      maxMessages: 10,
      maxChars: 1_000,
    });
    expect(result).toEqual({ items, truncated: false, returnedCount: 3, totalCount: 3 });
  });

  it("truncates on the message-count cap alone", () => {
    const items = [1, 2, 3, 4, 5];
    const result = truncateBySize(items, () => messageMeasure(1), {
      maxMessages: 3,
      maxChars: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(3);
    expect(result.totalCount).toBe(5);
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("truncates on the char cap alone", () => {
    const items = [1, 2, 3];
    const result = truncateBySize(items, () => messageMeasure(40), {
      maxMessages: 100,
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(2);
    expect(result.totalCount).toBe(3);
  });

  it("always keeps at least one item — a single oversized message is returned whole, never dropped", () => {
    const items = ["huge-message"];
    const result = truncateBySize(items, () => messageMeasure(10_000), {
      maxMessages: 10,
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.items).toEqual(["huge-message"]);
  });

  it("drops a second item, however small, once the first oversized item already fills the caps", () => {
    const items = ["huge", "tiny"];
    const result = truncateBySize(items, (item) => messageMeasure(item === "huge" ? 10_000 : 1), {
      maxMessages: 10,
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(1);
    expect(result.items).toEqual(["huge"]);
  });

  it("returns an untruncated, zero-count result for an empty input array", () => {
    const result = truncateBySize([], () => messageMeasure(0));
    expect(result).toEqual({ items: [], truncated: false, returnedCount: 0, totalCount: 0 });
  });

  it("stays untruncated exactly at the message-count cap boundary", () => {
    const items = [1, 2, 3];
    const result = truncateBySize(items, () => messageMeasure(1), {
      maxMessages: 3,
      maxChars: 1_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.returnedCount).toBe(3);
  });

  it("uses the default caps (MAX_THREAD_MESSAGES / MAX_THREAD_MESSAGES * MAX_BODY_CHARS_PER_MESSAGE) when none are given", () => {
    const items = Array.from({ length: 15 }, (_, i) => i);
    const result = truncateBySize(items, () => messageMeasure(0));
    expect(result.truncated).toBe(true);
    expect(result.returnedCount).toBe(10);
    expect(result.totalCount).toBe(15);
  });
});

describe("measureMessage", () => {
  it("returns {messages: 1, chars} for the given char count", () => {
    expect(measureMessage(42)).toEqual({ messages: 1, chars: 42 });
  });
});
