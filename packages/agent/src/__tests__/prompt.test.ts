import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { assemblePrefix } from "../prompt";
import type { AgentDefinition, ToolSpec } from "../types";

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

function tool(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: "get_current_time",
    description: "Returns the current time.",
    schema: z.object({}),
    handler: async () => new Date().toISOString(),
    requiresApproval: false,
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

  it("is still byte-identical across two independent calls once tools is non-empty", () => {
    const definitionWithTools = definition({
      tools: [tool({ name: "zebra" }), tool({ name: "alpha" })],
    });

    const first = assemblePrefix(definitionWithTools);
    const second = assemblePrefix(definitionWithTools);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.toolDefs).toHaveLength(2);
  });

  it("sorts tools by name regardless of declaration order", () => {
    const declaredZebraFirst = assemblePrefix(
      definition({ tools: [tool({ name: "zebra" }), tool({ name: "alpha" })] }),
    );
    const declaredAlphaFirst = assemblePrefix(
      definition({ tools: [tool({ name: "alpha" }), tool({ name: "zebra" })] }),
    );

    expect(declaredZebraFirst.toolDefs.map((t) => t.name)).toEqual(["alpha", "zebra"]);
    expect(JSON.stringify(declaredZebraFirst)).toBe(JSON.stringify(declaredAlphaFirst));
  });

  it("emits each tool's JSON Schema with sorted keys, deterministically", () => {
    const withTool = assemblePrefix(
      definition({
        tools: [
          tool({
            name: "get_current_time",
            description: "Returns the current time.",
            schema: z.object({ zeta: z.string().optional(), alpha: z.number().optional() }),
          }),
        ],
      }),
    );

    expect(withTool.toolDefs).toEqual([
      {
        name: "get_current_time",
        description: "Returns the current time.",
        parameters: expect.any(Object),
      },
    ]);
    // Property key order within the derived JSON Schema is sorted, not
    // declaration order — proven at the byte level via JSON.stringify.
    const parametersJson = JSON.stringify(withTool.toolDefs[0]?.parameters);
    expect(parametersJson.indexOf('"additionalProperties"')).toBeLessThan(
      parametersJson.indexOf('"properties"'),
    );
  });
});
