import type { ToolSpec } from "@hermes/agent";
import { z } from "zod/v4";

/**
 * ROADMAP-named throwaway tool (plans/03-agent-core.md Phase 3): its only
 * job, alongside `get_current_time`, is to exercise the approval gate — not
 * a real feature (see the plan's explicit non-goals). Defined here, never in
 * `packages/agent`, per the D4-seam boundary rule (settled decision 10):
 * `packages/agent` never imports a feature package. `requiresApproval: true`
 * makes this the one tool in this PRD that ever reaches the approval gate.
 */
export const echoTool: ToolSpec = {
  name: "echo",
  description: "Echoes the given text back, unchanged. Requires human approval before running.",
  schema: z.object({ text: z.string() }),
  handler: async (args) => (args as { text: string }).text,
  requiresApproval: true,
};
