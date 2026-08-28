import { type Agent, type AgentDefinition, createAgent } from "@hermes/agent";
import type { LlmProvider } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { buildThreadRepo } from "../store/build-thread-repo";
import { getCurrentTimeTool } from "./tools/get-current-time";

/**
 * Fixed placeholder — the same text `apps/hermes/src/handlers/complete.ts`
 * used as `SYSTEM_PROMPT_PLACEHOLDER` before this phase moved it here.
 * Anything richer is a later phase's job, not this one's.
 */
const SYSTEM_PROMPT = "You are Hermes, a helpful assistant.";

/**
 * The existing channel-identifier convention: `apps/hermes/src/handlers/
 * complete.ts`'s dedupe key is `telegram:<updateId>` — this is the only
 * place "telegram" is already spelled out as an identifier anywhere in this
 * codebase, so `AgentDefinition.channels` reuses that exact string rather
 * than inventing a new constant.
 */
const CHANNEL_TELEGRAM = "telegram";

/**
 * The only place allowed to import both `@hermes/agent` and construct the
 * one hardcoded `AgentDefinition` — the D4 seam (settled decision 10):
 * `apps/hermes` passes a single-entry `AgentDefinition[]` at boot, nothing
 * here makes a second agent more than a second list entry away. `tools:
 * [getCurrentTimeTool]` this phase; Phase 3 adds `echo`.
 */
export function buildAgent(
  pool: Pool,
  llmProvider: LlmProvider,
  model: string,
  telemetryRecorder: TelemetryRecorderHandle,
  signal: AbortSignal,
): Agent {
  const definition: AgentDefinition = {
    name: "hermes",
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [getCurrentTimeTool],
    channels: [CHANNEL_TELEGRAM],
  };

  return createAgent(definition, {
    llmProvider,
    threadRepo: buildThreadRepo(pool),
    telemetryRecorder,
    signal,
  });
}

export { CHANNEL_TELEGRAM };
export type { Agent };
