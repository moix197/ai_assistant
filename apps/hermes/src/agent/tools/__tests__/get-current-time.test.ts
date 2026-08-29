import { describe, expect, it } from "vitest";
import { getCurrentTimeTool } from "../get-current-time";

describe("getCurrentTimeTool", () => {
  it("carries the ROADMAP-named identity and requires no approval", () => {
    expect(getCurrentTimeTool.name).toBe("get_current_time");
    expect(getCurrentTimeTool.requiresApproval).toBe(false);
  });

  it("declares a schema that takes no arguments", () => {
    expect(getCurrentTimeTool.schema.safeParse({}).success).toBe(true);
    expect(getCurrentTimeTool.schema.safeParse("not an object").success).toBe(false);
  });

  it("returns a valid ISO-8601 string close to now", async () => {
    const before = Date.now();
    const result = await getCurrentTimeTool.handler(
      {},
      {
        signal: new AbortController().signal,
        channel: "telegram",
        channelUserId: "123",
        turnId: "turn-1",
      },
    );
    const after = Date.now();

    expect(typeof result).toBe("string");
    const parsed = Date.parse(result as string);
    expect(result).toBe(new Date(parsed).toISOString());
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
