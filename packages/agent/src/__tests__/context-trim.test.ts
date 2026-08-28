import type { Message } from "@hermes/core";
import { describe, expect, it } from "vitest";
import { trimHistory } from "../context-trim";

function userMessage(content: string): Message {
  return { role: "user", content };
}

function assistantWithToolCalls(argsBlobLength: number, toolCallId = "c1"): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: toolCallId, name: "big_tool", arguments: { blob: "x".repeat(argsBlobLength) } },
    ],
  };
}

function toolResult(content: string, toolCallId = "c1"): Message {
  return { role: "tool", content, toolCallId };
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

  it("drops a trim-boundary-crossing tool-call group whole, never orphaning the role:'tool' message from the assistant toolCalls message it answers", () => {
    // Sized so the boundary falls *inside* this group under the old,
    // per-message algorithm: dropping just the (large) assistant message
    // alone would already bring the running total under budget, leaving the
    // (tiny) tool-result message behind with no preceding assistant
    // toolCalls message — exactly the orphaning group-aware trim exists to
    // prevent.
    const bigAssistant = assistantWithToolCalls(2_000); // estimate ~500
    const smallToolResult = toolResult("ok"); // estimate ~1
    const newest = userMessage("z".repeat(40)); // estimate 10

    const result = trimHistory([bigAssistant, smallToolResult, newest], 100);

    expect(result).toEqual([newest]);
  });

  it("keeps a tool-call group whole when it fits the budget, rather than splitting it even though it could technically fit partially", () => {
    const assistant = assistantWithToolCalls(20); // small
    const result_ = toolResult("ok");
    const newest = userMessage("hi");

    const result = trimHistory([assistant, result_, newest], 1_000);

    expect(result).toEqual([assistant, result_, newest]);
  });

  it("counts a tool call's serialized arguments toward its size, not just plain .content, so a tool-heavy message now registers against the budget instead of estimating to (near) zero", () => {
    // `content` is empty here — under the old content-only estimate this
    // message sized to 0 and could never be a trim candidate regardless of
    // budget. Counting its tool call's serialized `arguments` is what makes
    // it correctly outweigh a tiny budget.
    const heavy = assistantWithToolCalls(2_000);
    const newest = userMessage("keep me");

    const result = trimHistory([heavy, newest], 100);

    expect(result).toEqual([newest]);
  });

  it("drops an older tool-call group entirely while keeping a newer, separate tool-call group intact", () => {
    // Two distinct groups. Sized so a message-granularity drop (dropping
    // just the oldest single message) would already bring the running total
    // under budget — leaving the older group's role:"tool" message behind,
    // orphaned from the assistant toolCalls message it answers. Only a
    // group-granularity drop removes the whole older group and leaves the
    // newer group untouched.
    const oldAssistant = assistantWithToolCalls(400, "c1"); // estimate ~103
    const oldToolResult = toolResult("a".repeat(20), "c1"); // estimate 5
    const newAssistant = assistantWithToolCalls(20, "c2"); // estimate ~8
    const newToolResult = toolResult("ok", "c2"); // estimate ~1

    const result = trimHistory([oldAssistant, oldToolResult, newAssistant, newToolResult], 20);

    expect(result).not.toContainEqual(oldAssistant);
    expect(result).not.toContainEqual(oldToolResult);
    expect(result).toEqual([newAssistant, newToolResult]);
  });
});
