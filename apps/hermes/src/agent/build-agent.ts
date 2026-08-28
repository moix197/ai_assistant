import { type Agent, type AgentDefinition, type ThreadRepo, createAgent } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
import type { LlmProvider } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { buildThreadRepo } from "../store/build-thread-repo";
import { createTelegramApprovalGate } from "./telegram-approval-gate";
import { echoTool } from "./tools/echo";
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
 * Wraps `buildThreadRepo`'s `ThreadRepo` with an in-memory
 * `threadId -> chatId` index, populated as a side effect of every
 * `getOrCreateThread` call. `ApprovalGate.requestApproval`'s context
 * deliberately carries only `{ threadId, turnId }` (`packages/agent`'s port
 * is channel-agnostic, so it can't know about Telegram chat ids), but
 * `createTelegramApprovalGate`'s `targetResolver` needs the reverse mapping
 * to know where to send/edit the approval prompt. `packages/store` has no
 * `getThreadById` lookup (not part of this phase's file changes), so this
 * index is built here, in `apps/hermes`, from data already flowing through
 * `runTurn` — every turn loads its thread before it can ever reach a gated
 * tool call, so the entry always exists by the time `requestApproval` runs.
 */
function createThreadRepoWithChatIndex(pool: Pool): {
  threadRepo: ThreadRepo;
  resolveChatId: (threadId: string) => string;
} {
  const chatIdByThreadId = new Map<string, string>();
  const base = buildThreadRepo(pool);

  const threadRepo: ThreadRepo = {
    async getOrCreateThread(channel, chatId) {
      const thread = await base.getOrCreateThread(channel, chatId);
      chatIdByThreadId.set(thread.id, thread.chatId);
      return thread;
    },
    appendMessages: (threadId, messages) => base.appendMessages(threadId, messages),
  };

  const resolveChatId = (threadId: string): string => {
    const chatId = chatIdByThreadId.get(threadId);
    if (chatId === undefined) {
      throw new Error(
        `no known chat for thread ${threadId} — approval requested before its thread was loaded`,
      );
    }
    return chatId;
  };

  return { threadRepo, resolveChatId };
}

export interface BuiltAgent {
  agent: Agent;
  /** Resolves a tapped Approve/Deny button — `boot.ts` wires this into the channel's callback inbound kind. */
  handleApprovalCallback(callback: InboundCallback): Promise<void>;
}

/**
 * The only place allowed to import both `@hermes/agent` and construct the
 * one hardcoded `AgentDefinition` — the D4 seam (settled decision 10):
 * `createAgent` takes one `AgentDefinition`, not a list, and this is the
 * one call site. Agent #2 means a second `createAgent` call plus a routing
 * decision, not "one more list entry" — see
 * `.ai/decisions/agent-multi-agent-seam.md`. `tools:
 * [getCurrentTimeTool, echoTool]` — `echo` is the one gated tool this PRD
 * ships, so this is also the only place that constructs the
 * `TelegramApprovalGate` and wires it into `createAgent`'s deps.
 */
export function buildAgent(
  pool: Pool,
  llmProvider: LlmProvider,
  model: string,
  telemetryRecorder: TelemetryRecorderHandle,
  signal: AbortSignal,
  channel: TelegramPoller,
): BuiltAgent {
  const { threadRepo, resolveChatId } = createThreadRepoWithChatIndex(pool);
  const approvalGate = createTelegramApprovalGate(channel, resolveChatId);

  const definition: AgentDefinition = {
    name: "hermes",
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [getCurrentTimeTool, echoTool],
    channels: [CHANNEL_TELEGRAM],
  };

  const agent = createAgent(definition, {
    llmProvider,
    threadRepo,
    telemetryRecorder,
    signal,
    approvalGate,
  });

  return { agent, handleApprovalCallback: approvalGate.handleCallback };
}

export { CHANNEL_TELEGRAM };
export type { Agent };
