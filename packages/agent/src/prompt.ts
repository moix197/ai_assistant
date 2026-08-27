import type { ToolDefinition } from "@hermes/llm";
import { z } from "zod/v4";
import type { AgentDefinition, ToolSpec } from "./types";

export interface AssembledPrefix {
  system: string;
  toolDefs: ToolDefinition[];
}

/**
 * Recursively sorts every object's keys — arrays keep their order, only
 * object key order changes. `JSON.stringify` (and therefore the request
 * body's own byte layout) preserves object-key insertion order, so this is
 * what makes two independently-derived JSON Schemas for the same zod schema
 * byte-identical regardless of property declaration order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

function toToolDefinition(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: sortKeysDeep(z.toJSONSchema(spec.schema)) as Record<string, unknown>,
  };
}

/**
 * Assembles the byte-stable prefix (invariant #6): `system` is
 * `definition.systemPrompt` verbatim — static, zero dynamic content, no
 * dates, no user names, current time is a *tool*, never a prompt line.
 * `toolDefs` derives each tool's JSON Schema deterministically: tools sorted
 * by name first, each schema's own keys emitted in sorted order via
 * `sortKeysDeep`. Two independent calls with the same `definition` produce
 * byte-identical output — proven with `definition.tools = []` this phase
 * (`__tests__/prompt.test.ts`); Phase 2 reuses this same function unmodified
 * once `definition.tools` is non-empty.
 */
export function assemblePrefix(definition: AgentDefinition): AssembledPrefix {
  const toolDefs = [...definition.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toToolDefinition);

  return { system: definition.systemPrompt, toolDefs };
}
