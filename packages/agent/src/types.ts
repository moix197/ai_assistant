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
  /**
   * `ctx.channel`/`ctx.channelUserId` identify who is asking — threaded
   * through from `runTurn`'s own `channel`/`channelUserId` parameters (the
   * latter itself threaded from `Agent.handleMessage`). `whoami`
   * (`apps/hermes/src/agent/tools/whoami.ts`, `04-google-auth` Phase 3) is
   * the first tool that needs this: a required-field widening of this
   * contract, not an additive one, so every existing `ctx` literal
   * (including in tests that invoke a handler directly) must supply both.
   */
  handler: (
    args: unknown,
    ctx: { signal: AbortSignal; channel: string; channelUserId: string },
  ) => Promise<unknown>;
  /**
   * Gates this tool behind the approval flow: `true` routes the call through
   * `runGatedToolCalls`, which requires `RunTurnDeps.approvalGate` (enforced
   * at construction via `assertApprovalGateConfigured`). `echoTool`
   * (`apps/hermes/src/agent/tools/echo.ts`) is the one tool that sets this.
   */
  requiresApproval: boolean;
}

/**
 * The one configuration object per agent — the D4 multi-agent seam
 * (settled decision 10): reserved, not built. `createAgent` takes one
 * `AgentDefinition`, not a list; `apps/hermes` constructs exactly one at
 * boot (`build-agent.ts`). Agent #2 is a second `createAgent` call plus
 * whatever decides which agent a message goes to — not "one more list
 * entry" — see `.ai/decisions/agent-multi-agent-seam.md`. `packages/agent`
 * never imports a feature package — `tools` are defined in `apps/hermes`
 * and passed in already-built.
 */
export interface AgentDefinition {
  name: string;
  model: string;
  systemPrompt: string;
  tools: ToolSpec[];
  channels: string[];
}
