import type { ApprovalGate, ApprovalRequest } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
import { delay, newId } from "@hermes/core";

/** An unanswered approval resolves as a denial after this long (settled decision 7). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** The identical reply for an unknown, already-resolved, or post-restart callback id — one branch, three causes (settled decision 7). */
const EXPIRED_CALLBACK_TEXT = "this approval has expired, please ask again";

const APPROVE_LABEL = "Approve";
const DENY_LABEL = "Deny";

export interface TelegramApprovalGate extends ApprovalGate {
  /** Resolves a tapped Approve/Deny button — wire this into the channel's callback inbound kind (`subscribeCallback`) in `boot.ts`. */
  handleCallback(callback: InboundCallback): Promise<void>;
}

interface PendingApproval {
  batch: ApprovalRequest[];
  target: string;
  messageId: string;
  resolve: (decision: "approved" | "denied") => void;
}

function formatBatchPrompt(batch: ApprovalRequest[]): string {
  const lines = batch.map((request) => `- ${request.tool}(${JSON.stringify(request.args)})`);
  return ["The model wants to run:", ...lines, "", "Approve or deny?"].join("\n");
}

function formatResolvedText(batch: ApprovalRequest[], label: string): string {
  return `${formatBatchPrompt(batch)}\n\n${label}`;
}

function callbackData(approvalId: string, action: "approve" | "deny"): string {
  return `${approvalId}:${action}`;
}

/**
 * Channel-agnostic `ApprovalGate` (`@hermes/agent`) implemented over
 * Telegram inline keyboards (`plans/03-agent-core.md` Phase 3). One combined
 * prompt per batch (settled decision 5); in-memory only, never persisted
 * (settled decision 6) — a restart drops any pending approval, and a
 * `callback_query` against a now-unknown id gets the same expiry reply as
 * one that's simply already resolved.
 *
 * Resolution — a tap (`handleCallback`), the `timeoutMs` window, or the
 * turn's own `AbortSignal` firing — is **one code path**: whichever fires
 * first synchronously deletes the `pending` map entry *before* any `await`
 * (including the `editMessage` that shows the resolved state), so the other
 * two triggers can never also resolve the same approval (settled decision
 * 7). The timeout races against `signal` using `delay(timeoutMs, signal)`
 * composed (`AbortSignal.any`) with a controller this function aborts once a
 * tap wins first — the same early-cancel pattern `packages/agent`'s
 * `invokeTool` uses for its own handler-timeout race — so an abort or a tap
 * never leaves the other trigger's timer leaking.
 *
 * `targetResolver` maps a turn's `threadId` to the Telegram chat id to
 * send/edit into — `apps/hermes/src/agent/build-agent.ts` supplies one
 * backed by an in-memory index populated as threads are loaded, since
 * `ApprovalGate`'s context deliberately carries no chat id (channel-agnostic
 * port).
 */
export function createTelegramApprovalGate(
  channel: TelegramPoller,
  targetResolver: (threadId: string) => string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): TelegramApprovalGate {
  const pending = new Map<string, PendingApproval>();

  async function requestApproval(
    batch: ApprovalRequest[],
    context: { threadId: string; turnId: string },
    signal: AbortSignal,
  ): Promise<"approved" | "denied"> {
    const approvalId = newId();
    const target = targetResolver(context.threadId);
    const { messageId } = await channel.send(target, formatBatchPrompt(batch), {
      buttons: [
        [
          { label: APPROVE_LABEL, callbackData: callbackData(approvalId, "approve") },
          { label: DENY_LABEL, callbackData: callbackData(approvalId, "deny") },
        ],
      ],
    });

    const tapWon = new AbortController();
    const raceSignal = AbortSignal.any([signal, tapWon.signal]);

    const decision = await new Promise<"approved" | "denied">((resolve) => {
      pending.set(approvalId, { batch, target, messageId, resolve });

      void delay(timeoutMs, raceSignal).then(() => {
        // Already resolved by a tap (handleCallback deletes synchronously,
        // before any await) — this leftover cleanup is then a no-op.
        const entry = pending.get(approvalId);
        if (!entry) return;
        pending.delete(approvalId);
        entry.resolve("denied");
      });
    });

    // No-op if the timeout already fired; cancels the still-pending delay
    // timer immediately when a tap resolved first instead of leaking it.
    tapWon.abort();

    if (signal.aborted) {
      // Shutting down: no further Telegram calls (settled decision 7).
      return decision;
    }

    const label = decision === "approved" ? "Approved." : "Denied (or expired).";
    await channel.editMessage(target, messageId, formatResolvedText(batch, label)).catch(() => {});
    return decision;
  }

  async function handleCallback(callback: InboundCallback): Promise<void> {
    const separatorIndex = callback.callbackData.lastIndexOf(":");
    const approvalId = separatorIndex === -1 ? callback.callbackData : callback.callbackData.slice(0, separatorIndex);
    const action = separatorIndex === -1 ? "" : callback.callbackData.slice(separatorIndex + 1);
    const entry = pending.get(approvalId);

    if (!entry) {
      await channel.answerCallback(callback.callbackId, EXPIRED_CALLBACK_TEXT).catch(() => {});
      return;
    }

    // Synchronous, before any await: the invariant every other trigger relies on.
    pending.delete(approvalId);
    const decision: "approved" | "denied" = action === "approve" ? "approved" : "denied";
    entry.resolve(decision);

    const label = decision === "approved" ? "Approved." : "Denied.";
    await channel.answerCallback(callback.callbackId, label).catch(() => {});
    await channel
      .editMessage(entry.target, entry.messageId, formatResolvedText(entry.batch, label))
      .catch(() => {});
  }

  return { requestApproval, handleCallback };
}
