import type { ApprovalGate, ApprovalRequest } from "@hermes/agent";
import type { InboundCallback, TelegramPoller } from "@hermes/channels";
import { type Logger, delay, newId } from "@hermes/core";
import { formatBatchPrompt, formatResolvedText } from "./approval-prompt-renderer";

/** An unanswered approval resolves as a denial after this long (settled decision 7). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** The identical reply for an unknown, already-resolved, or post-restart callback id — one branch, three causes (settled decision 7). Spanish tuteo, matching this plan's other user-facing copy (e.g. `sheets-write.ts`'s approval-prompt text). Still the fallback used whenever `describeExpiredApproval` (below) is absent, returns `undefined`, or throws. */
const EXPIRED_CALLBACK_TEXT = "esta aprobación ya expiró, pídelo de nuevo";

const APPROVE_LABEL = "Aprobar";
const DENY_LABEL = "Rechazar";

/**
 * This gate is Telegram-only by construction (`createTelegramApprovalGate`'s
 * one `TelegramPoller` argument), so the `channel` string
 * `describeExpiredApproval` (below) receives is this fixed literal — the
 * same raw string `apps/hermes/src/agent/build-agent.ts`'s own
 * `CHANNEL_TELEGRAM` already spells out for the identical dedupe-key
 * convention, duplicated here rather than imported to avoid a dependency
 * from this file back onto `build-agent.ts`.
 */
const TELEGRAM_CHANNEL = "telegram";

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

function callbackData(approvalId: string, action: "approve" | "deny"): string {
  return `${approvalId}:${action}`;
}

/**
 * Logs each ready call's raw args and resolved plan at debug level, right
 * before the prompt is sent — `06-legible-approvals-bounded-reads` Phase 3.
 * `plan` (never `summary`, which never carries this level of detail, e.g.
 * `sheets_write`'s `spreadsheetId`/effective `valueInputOption`) so an
 * operator can see exactly what a tool resolved without it ever reaching
 * chat. Off by default in production (debug level).
 */
function logPreparedBatch(logger: Logger, batch: ApprovalRequest[]): void {
  for (const request of batch) {
    logger.debug("approval prompt prepared", {
      tool: request.tool,
      args: request.args,
      plan: request.plan,
    });
  }
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
 * first synchronously deletes the `pending` map entry *before* any `await`,
 * so the other two triggers can never also resolve the same approval
 * (settled decision 7). The post-resolution `editMessage` is owned by
 * whichever trigger synchronously won: a tap edits inside `handleCallback`;
 * the timeout/abort race edits inside `requestApproval` itself (guarded by
 * `resolvedByTimer`, since both share that one `delay(...).then()`
 * continuation) — never both, so exactly one `editMessage` call happens per
 * resolution. The timeout races against `signal` using `delay(timeoutMs,
 * signal)` composed (`AbortSignal.any`) with a controller this function
 * aborts once a tap wins first — the same early-cancel pattern
 * `packages/agent`'s `invokeToolHandler` uses for its own handler-timeout
 * race — so an abort or a tap never leaves the other trigger's timer
 * leaking.
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
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /**
   * `09-gmail-read-then-send` Phase 5 — an optional, purely-descriptive
   * lookup consulted only on the `pending.get()` miss branch below (unknown,
   * already-resolved, or post-restart callback id). Never executes a tool,
   * never resolves a pending approval, never touches `pending` — it only
   * reads a durable log (e.g. `gmail_send_log` via
   * `findLatestGmailSendIntent`) to report what did or didn't happen. A
   * thrown error or a DB genuinely being down must never break the tap
   * handler, so it is always awaited inside a `try`/`catch` that falls back
   * to `EXPIRED_CALLBACK_TEXT` byte-identically, the same as an absent
   * callback or one resolving to `undefined`.
   */
  describeExpiredApproval?: (channel: string, channelUserId: string) => Promise<string | undefined>,
): TelegramApprovalGate {
  const pending = new Map<string, PendingApproval>();

  async function resolveExpiredText(channelUserId: string): Promise<string> {
    if (!describeExpiredApproval) return EXPIRED_CALLBACK_TEXT;
    try {
      const described = await describeExpiredApproval(TELEGRAM_CHANNEL, channelUserId);
      return described ?? EXPIRED_CALLBACK_TEXT;
    } catch {
      return EXPIRED_CALLBACK_TEXT;
    }
  }

  async function requestApproval(
    batch: ApprovalRequest[],
    context: { threadId: string; turnId: string },
    signal: AbortSignal,
  ): Promise<"approved" | "denied"> {
    const approvalId = newId();
    const target = targetResolver(context.threadId);
    logPreparedBatch(logger, batch);
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

    // Set when this function's own delay-race resolves the promise (timeout
    // or abort) rather than a tap — the flag is how requestApproval knows it,
    // not handleCallback, owns the post-resolution edit for this decision.
    let resolvedByTimer = false;

    const decision = await new Promise<"approved" | "denied">((resolve) => {
      pending.set(approvalId, { batch, target, messageId, resolve });

      void delay(timeoutMs, raceSignal).then(() => {
        // Already resolved by a tap (handleCallback deletes synchronously,
        // before any await) — this leftover cleanup is then a no-op.
        const entry = pending.get(approvalId);
        if (!entry) return;
        pending.delete(approvalId);
        resolvedByTimer = true;
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

    if (resolvedByTimer) {
      // A tap already made its own editMessage call inside handleCallback —
      // only edit here when this race, not a tap, won the resolution.
      const label = "Rechazado (o expiró).";
      await channel
        .editMessage(target, messageId, formatResolvedText(batch, label))
        .catch(() => {});
    }
    return decision;
  }

  async function handleCallback(callback: InboundCallback): Promise<void> {
    const separatorIndex = callback.callbackData.lastIndexOf(":");
    const approvalId =
      separatorIndex === -1
        ? callback.callbackData
        : callback.callbackData.slice(0, separatorIndex);
    const action = separatorIndex === -1 ? "" : callback.callbackData.slice(separatorIndex + 1);
    const entry = pending.get(approvalId);

    if (!entry) {
      const text = await resolveExpiredText(callback.channelUserId);
      await channel.answerCallback(callback.callbackId, text).catch(() => {});
      await channel.editMessage(callback.chatId, callback.messageId, text).catch(() => {});
      return;
    }

    // Synchronous, before any await: the invariant every other trigger relies on.
    pending.delete(approvalId);
    const decision: "approved" | "denied" = action === "approve" ? "approved" : "denied";
    entry.resolve(decision);

    const label = decision === "approved" ? "Aprobado." : "Rechazado.";
    await channel.answerCallback(callback.callbackId, label).catch(() => {});
    await channel
      .editMessage(entry.target, entry.messageId, formatResolvedText(entry.batch, label))
      .catch(() => {});
  }

  return { requestApproval, handleCallback };
}
