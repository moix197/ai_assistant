import { type RunTurnDeps, runTurn } from "./loop";
import type { AgentDefinition } from "./types";

export interface Agent {
  handleMessage(channel: string, chatId: string, text: string): Promise<string>;
}

/**
 * Thin factory wrapping `runTurn` plus the injected deps into a
 * `{ handleMessage }` object — the one public entry point a caller (e.g.
 * `apps/hermes/src/agent/build-agent.ts`) needs.
 */
export function createAgent(definition: AgentDefinition, deps: RunTurnDeps): Agent {
  return {
    handleMessage: (channel, chatId, text) => runTurn(definition, deps, channel, chatId, text),
  };
}

export type { Thread, ThreadRepo } from "./thread-repo-port";
export type { AgentDefinition, ToolSpec } from "./types";
export type { Message } from "@hermes/core";
