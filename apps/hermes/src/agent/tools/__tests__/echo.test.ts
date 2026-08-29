import { describe, expect, it } from "vitest";
import { echoTool } from "../echo";

describe("echoTool", () => {
  it("carries the ROADMAP-named identity and requires approval", () => {
    expect(echoTool.name).toBe("echo");
    expect(echoTool.requiresApproval).toBe(true);
  });

  it("declares a schema requiring a text string", () => {
    expect(echoTool.schema.safeParse({ text: "hi" }).success).toBe(true);
    expect(echoTool.schema.safeParse({}).success).toBe(false);
    expect(echoTool.schema.safeParse({ text: 5 }).success).toBe(false);
  });

  it("returns its input text unchanged", async () => {
    const result = await echoTool.handler(
      { text: "hello world" },
      {
        signal: new AbortController().signal,
        channel: "telegram",
        channelUserId: "123",
        turnId: "turn-1",
      },
    );
    expect(result).toBe("hello world");
  });
});
