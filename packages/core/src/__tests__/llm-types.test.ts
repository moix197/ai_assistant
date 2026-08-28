import { describe, expect, it } from "vitest";
import { messageSchema, messagesArraySchema } from "../llm-types";

describe("messageSchema", () => {
  it("parses a valid system message", () => {
    const message = { role: "system", content: "you are a helpful assistant" };
    expect(messageSchema.parse(message)).toEqual(message);
  });

  it("parses a valid user message", () => {
    const message = { role: "user", content: "hi" };
    expect(messageSchema.parse(message)).toEqual(message);
  });

  it("parses a valid assistant message with no tool calls", () => {
    const message = { role: "assistant", content: "hello there" };
    expect(messageSchema.parse(message)).toEqual(message);
  });

  it("parses a valid assistant message carrying toolCalls", () => {
    const message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "get_current_time", arguments: { tz: "UTC" } }],
    };
    expect(messageSchema.parse(message)).toEqual(message);
  });

  it("parses a valid tool message", () => {
    const message = { role: "tool", content: "12:00 UTC", toolCallId: "c1" };
    expect(messageSchema.parse(message)).toEqual(message);
  });

  it("rejects a role:'tool' message missing toolCallId", () => {
    const result = messageSchema.safeParse({ role: "tool", content: "12:00 UTC" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    const result = messageSchema.safeParse({ role: "bogus", content: "hi" });
    expect(result.success).toBe(false);
  });

  it("rejects a message missing content", () => {
    const result = messageSchema.safeParse({ role: "user" });
    expect(result.success).toBe(false);
  });
});

describe("messagesArraySchema", () => {
  it("parses a mixed array of all four valid role shapes", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
      },
      { role: "tool", content: "done", toolCallId: "c1" },
    ];
    expect(messagesArraySchema.parse(messages)).toEqual(messages);
  });

  it("rejects an array containing one invalid message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: "no id here" },
    ];
    expect(messagesArraySchema.safeParse(messages).success).toBe(false);
  });

  it("parses an empty array", () => {
    expect(messagesArraySchema.parse([])).toEqual([]);
  });
});
