import { type Agent, type AgentDefinition, type ThreadRepo, createAgent } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
import { type Logger, createLogger } from "@hermes/core";
import { TOOL_REQUIRED_SCOPES } from "@hermes/google-auth";
import type { SheetWriteLogPort, SheetsToolDeps, SheetsWritePlan } from "@hermes/google-sheets";
import {
  createSheetsInspectTool,
  createSheetsReadTool,
  createSheetsWriteTool,
} from "@hermes/google-sheets";
import type { LlmProvider } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import type { TelemetryRecorderHandle } from "@hermes/telemetry";
import { buildGoogleAccountRepo } from "../store/build-google-account-repo";
import { buildThreadRepo } from "../store/build-thread-repo";
import { createTelegramApprovalGate } from "./telegram-approval-gate";
import { echoTool } from "./tools/echo";
import { getCurrentTimeTool } from "./tools/get-current-time";
import { createWhoamiTool } from "./tools/whoami";
import { withRequiredScopes } from "./with-required-scopes";

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
 * Looks up a gated tool's required scopes from `TOOL_REQUIRED_SCOPES`
 * (`@hermes/google-auth`'s single source of truth for tool→scope) rather
 * than hardcoding them again at each `withRequiredScopes` call site below.
 * Throws if a tool name isn't registered in the map — the same fail-fast
 * posture `withRequiredScopes`'s own `toolName`/`spec.name` assertion takes:
 * a gated tool with no declared scope requirement is a wiring bug, not
 * something to silently gate on `[]`.
 */
function requiredScopesFor(toolName: string): string[] {
  const scopes = TOOL_REQUIRED_SCOPES.get(toolName);
  if (!scopes) {
    throw new Error(`no scopes registered for tool "${toolName}" in TOOL_REQUIRED_SCOPES`);
  }
  return [...scopes];
}

/**
 * The only place allowed to import both `@hermes/agent` and construct the
 * one hardcoded `AgentDefinition` — the D4 seam (settled decision 10):
 * `createAgent` takes one `AgentDefinition`, not a list, and this is the
 * one call site. Agent #2 means a second `createAgent` call plus a routing
 * decision, not "one more list entry" — see
 * `.ai/decisions/agent-multi-agent-seam.md`. `tools:
 * [getCurrentTimeTool, echoTool, whoamiTool]` — `echo` is the one gated tool
 * this PRD ships, so this is also the only place that constructs the
 * `TelegramApprovalGate` and wires it into `createAgent`'s deps. `whoamiTool`
 * (Phase 3) is built here too, with the same `pool`-backed
 * `buildGoogleAccountRepo` the OAuth connect flow already uses
 * (`boot.ts`'s `buildConnectFlow`), closed over via `createWhoamiTool` —
 * which (05-google-sheets Phase 2) now wraps its handler in
 * `withRequiredScopes`, the same decorator the Sheets tools (Phase 4/5) gate
 * on, rather than checking scopes inline. `sheetsInspectTool`/`sheetsReadTool`
 * (Phase 4) and `sheetsWriteTool` (Phase 5) are appended to the **end** of
 * the tools array — existing prefix bytes untouched (settled decision 16) —
 * built from `@hermes/google-sheets`'s base (ungated) tool factories over
 * `sheetsDeps` (constructed in `boot.ts`, passed in already-built) and gated
 * the same way `whoamiTool` is, each with its own `requiredScopes` read from
 * `TOOL_REQUIRED_SCOPES` (`requiredScopesFor` below) — the single place a
 * tool's scope requirement is declared, not re-hardcoded here. `sheetsWriteTool`
 * additionally takes `sheetWriteLogRepo` (constructed and wired in `boot.ts`,
 * the same inline-object shape `apps/hermes/src/handlers/complete.ts`'s
 * `dedupeRepo` already uses for `llm_dedupe`) — kept out of the shared
 * `SheetsToolDeps` type since `sheetsInspectTool`/`sheetsReadTool` never need it.
 */
export function buildAgent(
  pool: Pool,
  llmProvider: LlmProvider,
  model: string,
  telemetryRecorder: TelemetryRecorderHandle,
  signal: AbortSignal,
  channel: TelegramPoller,
  sheetsDeps: SheetsToolDeps,
  sheetWriteLogRepo: SheetWriteLogPort,
  /**
   * `06-legible-approvals-bounded-reads` Phase 3 — `createTelegramApprovalGate`
   * logs each ready call's raw args/resolved plan at debug level right
   * before sending its prompt. Optional, defaulting to a fresh `createLogger()`
   * (info level, so those debug lines stay silent) so `boot.ts`'s existing
   * call site keeps compiling unchanged; wiring the real, config-aware
   * logger through from `boot.ts` is left to a later pass, not this phase's
   * scope.
   */
  logger: Logger = createLogger(),
): BuiltAgent {
  const { threadRepo, resolveChatId } = createThreadRepoWithChatIndex(pool);
  const approvalGate = createTelegramApprovalGate(channel, resolveChatId, logger);
  const googleAccountRepo = buildGoogleAccountRepo(pool);
  const whoamiTool = createWhoamiTool(googleAccountRepo);

  const sheetsInspectTool = withRequiredScopes("sheets_inspect", {
    googleAccountRepo,
    requiredScopes: requiredScopesFor("sheets_inspect"),
  })(createSheetsInspectTool(sheetsDeps));
  const sheetsReadTool = withRequiredScopes("sheets_read", {
    googleAccountRepo,
    requiredScopes: requiredScopesFor("sheets_read"),
  })(createSheetsReadTool(sheetsDeps));
  const sheetsWriteTool = withRequiredScopes<SheetsWritePlan>("sheets_write", {
    googleAccountRepo,
    requiredScopes: requiredScopesFor("sheets_write"),
  })(createSheetsWriteTool({ ...sheetsDeps, sheetWriteLogRepo }));

  const definition: AgentDefinition = {
    name: "hermes",
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [
      getCurrentTimeTool,
      echoTool,
      whoamiTool,
      sheetsInspectTool,
      sheetsReadTool,
      sheetsWriteTool,
    ],
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
