/**
 * One tool call waiting on a human's yes/no, as shown to them — not the
 * validated `ToolSpec.schema` output, the model's raw requested arguments.
 * Channel-agnostic: `packages/agent` never imports `@hermes/channels`, so
 * this carries nothing Telegram-specific (no chat id, no message id — those
 * live in `apps/hermes/src/agent/telegram-approval-gate.ts`'s own
 * bookkeeping).
 */
export interface ApprovalRequest {
  tool: string;
  args: unknown;
  /**
   * The tool's resolved plan from `ToolSpec.prepare` (`packages/agent/src/
   * types.ts`) — absent for a prepare-less tool. Debug-log-only:
   * `TelegramApprovalGate` (`apps/hermes/src/agent/telegram-approval-gate.ts`)
   * logs it alongside the raw `args` right before sending the prompt, but
   * the renderer (`apps/hermes/src/agent/approval-prompt-renderer.ts`) never
   * reads it — only `summary` below is ever shown to a human. Generic
   * (`unknown`), like everything else on this channel-agnostic port;
   * `summary` deliberately never carries this level of detail (e.g.
   * `sheets_write`'s `spreadsheetId`).
   */
  plan?: unknown;
  /**
   * A small, generic display vocabulary a tool's `prepare` can populate so
   * the approval prompt shows something legible instead of raw JSON —
   * absent for a prepare-less tool, which falls back to the raw-JSON
   * rendering unchanged. Declared here, not derived from any feature
   * package, so `packages/agent` still imports nothing Sheets-specific
   * while the contract actually constrains what a tool can hand the gate
   * (rejected: `ApprovalSummary = unknown` — see `plans/
   * 06-legible-approvals-bounded-reads.md`'s Dependencies & Risks).
   */
  summary?: ApprovalSummary;
}

/**
 * The generic, tool-agnostic shape a `prepare` hook populates to make an
 * approval prompt legible: `action` is always the first line (a yes/no
 * question), `target` an optional second line naming what it acts on,
 * `items`/`itemsTotal` an optional preview list with a count line when
 * truncated, `effects` trailing sentences describing consequences. Exactly
 * these five fields — nothing speculative for a hypothetical future tool
 * (see `plans/06-legible-approvals-bounded-reads.md`'s Dependencies & Risks).
 */
export interface ApprovalSummary {
  action: string;
  target?: string;
  items?: string[];
  itemsTotal?: number;
  effects: string[];
}

/**
 * The injected approval port (Phase 3, `plans/03-agent-core.md`, settled
 * decisions 5-7/16). One call resolves a whole batch of gated tool calls
 * from the same model response together — a single combined prompt, not one
 * per call (settled decision 5). `signal` is the turn's own `AbortSignal`,
 * threaded through so a shutdown mid-wait resolves the batch as `"denied"`
 * immediately instead of leaking until the implementation's own timeout
 * (settled decision 7) — every implementation must race its timeout against
 * this signal with `delay(ms, signal)` from `@hermes/core`, the same helper
 * every other timeout in this PRD reuses.
 */
export interface ApprovalGate {
  requestApproval(
    batch: ApprovalRequest[],
    context: { threadId: string; turnId: string },
    signal: AbortSignal,
  ): Promise<"approved" | "denied">;
}
