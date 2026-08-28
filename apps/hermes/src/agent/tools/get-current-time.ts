import type { ToolSpec } from "@hermes/agent";
import { z } from "zod/v4";

/**
 * ROADMAP-named throwaway tool (plans/03-agent-core.md Phase 2): its only
 * job is to exercise the tool registry and, from Phase 3 on, the approval
 * gate — not a real feature (see the plan's explicit non-goals). Defined
 * here, never in `packages/agent`, per the D4-seam boundary rule (settled
 * decision 10): `packages/agent` never imports a feature package.
 */
export const getCurrentTimeTool: ToolSpec = {
  name: "get_current_time",
  description: "Returns the current date and time in ISO-8601 format. Takes no arguments.",
  schema: z.object({}),
  handler: async () => new Date().toISOString(),
  requiresApproval: false,
};
