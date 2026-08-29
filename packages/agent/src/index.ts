import { type RunTurnDeps, runTurn } from "./loop";
import type { AgentDefinition } from "./types";

export interface Agent {
  handleMessage(
    channel: string,
    chatId: string,
    channelUserId: string,
    text: string,
  ): Promise<string>;
}

/**
 * Fails fast, before any I/O, when `definition` configures a gated tool but
 * `deps` carries no `approvalGate` to ask it through — the alternative
 * (discovering this only at the first gated call, mid-turn) would silently
 * never ask. Called synchronously at construction, in `createAgent`, so a
 * misconfigured agent never boots successfully in the first place.
 */
function assertApprovalGateConfigured(definition: AgentDefinition, deps: RunTurnDeps): void {
  const needsGate = definition.tools.some((tool) => tool.requiresApproval);
  if (needsGate && !deps.approvalGate) {
    throw new Error(
      `agent "${definition.name}" has a tool requiring approval but no approvalGate was supplied`,
    );
  }
}

/**
 * Thin factory wrapping `runTurn` plus the injected deps into a
 * `{ handleMessage }` object — the one public entry point a caller (e.g.
 * `apps/hermes/src/agent/build-agent.ts`) needs. Validates the deps against
 * the definition (`assertApprovalGateConfigured`) here, at construction,
 * rather than at the first turn.
 */
export function createAgent(definition: AgentDefinition, deps: RunTurnDeps): Agent {
  assertApprovalGateConfigured(definition, deps);
  return {
    handleMessage: (channel, chatId, channelUserId, text) =>
      runTurn(definition, deps, channel, chatId, channelUserId, text),
  };
}

export type { ApprovalGate, ApprovalRequest, ApprovalSummary } from "./approval-gate-port";
export { assemblePrefix } from "./prompt";
export type { AssembledPrefix } from "./prompt";
export type { Thread, ThreadRepo } from "./thread-repo-port";
export type { AgentDefinition, ToolContext, ToolPreparation, ToolSpec } from "./types";
export type { Message } from "@hermes/core";
