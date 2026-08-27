import type { Message } from "@hermes/core";
import { describe, expect, it } from "vitest";
import { trimHistory } from "../context-trim";

function userMessage(content: string): Message {
  return { role: "user", content };
}

describe("trimHistory", () => {
  it("keeps everything when the estimated size is under budget", () => {
    const messages = [userMessage("short"), userMessage("also short")];

    expect(trimHistory(messages, 1_000)).toEqual(messages);
  });

  it("drops the oldest messages first once over budget", () => {
    // Each message estimates to content.length / 4. Budget chosen so only
    // the most recent message(s) fit.
    const oldest = userMessage("a".repeat(400)); // estimate 100
    const middle = userMessage("b".repeat(400)); // estimate 100
    const newest = userMessage("c".repeat(400)); // estimate 100

    const result = trimHistory([oldest, middle, newest], 150);

    expect(result).toEqual([newest]);
  });

  it("drops only as many oldest messages as needed to fit the budget", () => {
    const oldest = userMessage("a".repeat(400)); // estimate 100
    const middle = userMessage("b".repeat(400)); // estimate 100
    const newest = userMessage("c".repeat(400)); // estimate 100

    const result = trimHistory([oldest, middle, newest], 250);

    expect(result).toEqual([middle, newest]);
  });

  it("keeps a single message that alone exceeds the whole budget, rather than trimming to nothing", () => {
    const huge = userMessage("x".repeat(10_000));

    expect(trimHistory([huge], 10)).toEqual([huge]);
  });

  it("keeps the last message even when every message individually exceeds the budget", () => {
    const oldest = userMessage("a".repeat(10_000));
    const newest = userMessage("b".repeat(10_000));

    expect(trimHistory([oldest, newest], 10)).toEqual([newest]);
  });

  it("returns an empty array unchanged", () => {
    expect(trimHistory([], 1_000)).toEqual([]);
  });

  it("never receives, and so never drops, the caller's newest 'current' user message — that's the caller's contract, asserted here by never passing it in", () => {
    const history = [userMessage("earlier turn")];
    const trimmed = trimHistory(history, 1_000);

    // trimHistory only ever sees stored history; the caller (loop.ts)
    // appends the current user message *after* this call, so it is never a
    // candidate for trimming by construction — there is nothing here that
    // could drop it, because it is never part of the input.
    expect(trimmed).toEqual(history);
  });
});
