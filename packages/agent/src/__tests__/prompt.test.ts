import { describe, expect, it } from "vitest";
import { assemblePrefix } from "../prompt";
import type { AgentDefinition } from "../types";

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "hermes",
    model: "deepseek-v4-flash",
    systemPrompt: "You are Hermes, a helpful assistant.",
    tools: [],
    channels: ["telegram"],
    ...overrides,
  };
}

describe("assemblePrefix", () => {
  it("is byte-identical across two independent calls with the same definition (tools: [])", () => {
    const first = assemblePrefix(definition());
    const second = assemblePrefix(definition());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("returns the system prompt verbatim and an empty toolDefs array when tools is empty", () => {
    const prefix = assemblePrefix(definition({ systemPrompt: "verbatim text" }));

    expect(prefix.system).toBe("verbatim text");
    expect(prefix.toolDefs).toEqual([]);
  });

  it("changing systemPrompt changes system, and nothing else", () => {
    const a = assemblePrefix(definition({ systemPrompt: "prompt A" }));
    const b = assemblePrefix(definition({ systemPrompt: "prompt B" }));

    expect(a.system).toBe("prompt A");
    expect(b.system).toBe("prompt B");
    expect(a.toolDefs).toEqual(b.toolDefs);
  });

  it("takes no implicit dynamic input — repeated calls over time never drift", async () => {
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(JSON.stringify(assemblePrefix(definition())));
      // Force a real time gap so a hidden Date.now()/random-id dependency
      // would actually show up as drift, not just theoretical.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(new Set(results).size).toBe(1);
  });
});
