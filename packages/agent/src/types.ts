import type { z } from "zod/v4";

/** Reused, not redefined — `@hermes/core`'s `Message` is the one shared conversation-turn shape every package agrees on. */
export type { Message } from "@hermes/core";

/**
 * A tool made available to the model. `schema` is a `zod/v4` schema — its
 * JSON Schema is derived once, deterministically, by `assemblePrefix`
 * (`prompt.ts`). No mutable `register()`: tools are supplied once, at
 * `AgentDefinition` construction, because registration-order nondeterminism
 * would threaten the byte-stable prefix invariant #6 depends on.
 */
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>;
  /** Gates this tool behind the approval flow (Phase 3). Unused — every tool this phase has none — until then. */
  requiresApproval: boolean;
}

/**
 * The one configuration object per agent — the D4 multi-agent seam
 * (settled decision 10): reserved, not built. `apps/hermes` passes one
 * hardcoded `AgentDefinition[]` with a single entry at boot; nothing here
 * makes a second agent more than a second list entry away, but nothing here
 * adds that entry either. `packages/agent` never imports a feature package —
 * `tools` are defined in `apps/hermes` and passed in already-built.
 */
export interface AgentDefinition {
  name: string;
  model: string;
  systemPrompt: string;
  tools: ToolSpec[];
  channels: string[];
}
