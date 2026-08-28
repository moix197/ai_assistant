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
