import { MaxIterationsReachedError } from "@hermes/agent";
import { type Channel, type InboundMessage, TelegramPartialSendError } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { BudgetExceededError } from "@hermes/llm";
import type { LlmDedupeClaimResult } from "@hermes/store";
import { type Agent, CHANNEL_TELEGRAM } from "../agent/build-agent";

/**
 * Dedupe repo port, declared here rather than in `@hermes/llm`: dedupe is an
 * application-level concern (this handler owns claiming, not the adapter),
 * so it has no home in the LLM package's own port surface. `LlmDedupeClaimResult`
 * is imported, not redeclared, from `@hermes/store` — the single source for
 * that shape (see `packages/store/src/llm-dedupe-repo.ts`).
 * `apps/hermes/src/boot.ts` wires this to `@hermes/store`'s
 * `claim(pool, dedupeKey)` / `complete(pool, dedupeKey, resultText)`.
 */
export interface LlmDedupeRepo {
  claim(dedupeKey: string): Promise<LlmDedupeClaimResult>;
  complete(dedupeKey: string, resultText: string): Promise<void>;
}

/** Never leaks a stack trace or provider error detail into chat. */
export const GENERIC_FAILURE_REPLY =
  "Sorry, I couldn't process that message right now. Please try again in a moment.";

/**
 * Distinct from `GENERIC_FAILURE_REPLY`: a deliberate, fixed string, never
 * `BudgetExceededError.message` — that message carries `capUsd`/`spentUsd`,
 * useful in boot logs but not something to leak to chat by default. Spend
 * figures surface to users via `/stats` (02-telemetry), not here.
 */
const OUT_OF_BUDGET_REPLY =
  "Hermes is out of budget for this month. Please try again after the monthly reset.";

/**
 * Distinct from `GENERIC_FAILURE_REPLY`: this is not a failure — the agent
 * turn completed normally (no thrown error) but produced no usable text,
 * almost always because the model exhausted its output token budget on a
 * long request. Telegram's `sendMessage` rejects an empty string with a 400,
 * which without this guard falls through to the generic "something went
 * wrong" copy — misleading, since nothing actually failed. Spanish, tuteo,
 * matching the approval-gate copy shipped in plan 06. Exported so tests can
 * assert against it rather than duplicating the literal.
 */
export const EMPTY_REPLY_FALLBACK =
  "No pude generar una respuesta para eso. Prueba de nuevo, o pídemelo en partes más chicas.";

/**
 * Distinct from `GENERIC_FAILURE_REPLY`: this is not an error either — the
 * turn ran to completion (every iteration billed and reported), it just
 * never reached a final response within `MAX_ITERATIONS`. The user gets a
 * real result reported (the turn happened, it just didn't finish), not a
 * "something went wrong, try again" message.
 */
export const MAX_ITERATIONS_REPLY =
  "Esto se alargó demasiado y no llegué a una respuesta final. Pídemelo de nuevo, quizás en partes más chicas.";

/**
 * Distinct from `GENERIC_FAILURE_REPLY`: the user already received the
 * earlier chunk(s) of a multi-part reply before a later chunk failed to
 * send (see `TelegramPartialSendError`), so the generic "something went
 * wrong" copy would be misleading — they did get something. Spanish,
 * tuteo, matching `EMPTY_REPLY_FALLBACK` and `MAX_ITERATIONS_REPLY`.
 */
export const PARTIAL_SEND_NOTICE =
  "Se cortó la respuesta a la mitad. Pídemelo de nuevo, o en partes más chicas.";

export interface CreateCompletionHandlerOptions {
  channel: Channel;
  /** The agent loop (`packages/agent`, 2c) — replaces the single, stateless `llmProvider.complete()` call this phase used to make directly. */
  agent: Agent;
  logger: Logger;
  /**
   * Required, not optional: an optional-with-a-silent-no-dedupe default is
   * exactly the Phase-4 trap this project has already been burned by once
   * (a mechanism built and tested but never actually wired into the real
   * adapter). Making it mandatory means a dropped wire is a compile error,
   * not a silent gap. `apps/hermes/src/boot.ts` — the one real production
   * wiring site — always supplies a real, Postgres-backed one; see
   * `packages/store/README.md`'s `llm_dedupe` section for the claim/complete
   * states this guards.
   */
  dedupeRepo: LlmDedupeRepo;
}

/** `telegram:<update_id>` — stable across the exact-duplicate redelivery `dedupeRepo` exists to catch. */
function deriveDedupeKey(message: InboundMessage): string {
  return `${CHANNEL_TELEGRAM}:${message.updateId}`;
}

/**
 * Records the dedupe key as completed after a successful reply. The
 * provider call already succeeded and the reply already reached the user by
 * this point — a bookkeeping failure here must not surface a second,
 * confusing "sorry, try again" message on top of a reply that already
 * landed. Log and continue instead, mirroring the adapter's
 * `recordCompletionUsage` for the same reason.
 */
async function recordDedupeCompletion(
  dedupeRepo: LlmDedupeRepo,
  logger: Logger,
  dedupeKey: string,
  resultText: string,
): Promise<void> {
  try {
    await dedupeRepo.complete(dedupeKey, resultText);
  } catch (error) {
    logger.error(
      "failed to record dedupe completion — reply already sent, but the claim-to-complete window is not closed",
      { dedupeKey, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Sends a notice that isn't the ordinary happy-path reply (e.g. a
 * cut-off or failure notice) and swallows a delivery failure — the user
 * may have blocked the bot or be otherwise unreachable, which is not this
 * handler's error to surface as a crash. Returns whether delivery
 * succeeded so the caller can decide whether it's safe to record dedupe
 * completion. Introduced here as the first phase to add a new user-facing
 * notice send; reused by later phases' notice sends.
 */
async function sendUserNotice(
  options: CreateCompletionHandlerOptions,
  message: InboundMessage,
  text: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await options.channel.send(message.chatId, text);
    return true;
  } catch (sendError) {
    options.logger.warn(
      "failed to deliver notice to user — likely blocked the bot or unreachable",
      {
        ...context,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      },
    );
    return false;
  }
}

/**
 * The unclaimed path, in the load-bearing order documented on
 * `createCompletionHandler`: one agent turn, then the reply, then the
 * dedupe completion — never the completion first.
 */
async function replyWithCompletion(
  options: CreateCompletionHandlerOptions,
  message: InboundMessage,
  dedupeKey: string,
): Promise<void> {
  let agentReply: string;
  try {
    agentReply = await options.agent.handleMessage(
      CHANNEL_TELEGRAM,
      message.chatId,
      message.channelUserId,
      message.text,
    );
  } catch (error) {
    if (!(error instanceof MaxIterationsReachedError)) {
      throw error;
    }

    const delivered = await sendUserNotice(options, message, MAX_ITERATIONS_REPLY, {
      channelUserId: message.channelUserId,
      dedupeKey,
      iterations: error.iterations,
      totalCostUsd: error.totalCostUsd,
    });
    if (delivered) {
      options.logger.warn("agent turn reached MAX_ITERATIONS without a final response", {
        channelUserId: message.channelUserId,
        dedupeKey,
        iterations: error.iterations,
        totalCostUsd: error.totalCostUsd,
      });
      await recordDedupeCompletion(
        options.dedupeRepo,
        options.logger,
        dedupeKey,
        MAX_ITERATIONS_REPLY,
      );
    }
    return;
  }

  let resultText = agentReply;
  if (resultText.trim().length === 0) {
    options.logger.warn("agent turn completed with an empty reply, sending fallback text instead", {
      channelUserId: message.channelUserId,
      dedupeKey,
    });
    resultText = EMPTY_REPLY_FALLBACK;
  }

  try {
    await options.channel.send(message.chatId, resultText);
  } catch (error) {
    if (!(error instanceof TelegramPartialSendError)) {
      throw error;
    }

    const delivered = await sendUserNotice(options, message, PARTIAL_SEND_NOTICE, {
      channelUserId: message.channelUserId,
      dedupeKey,
      partsSent: error.partsSent,
      totalParts: error.totalParts,
    });
    if (delivered) {
      options.logger.warn("reply send failed partway through a multi-part message", {
        channelUserId: message.channelUserId,
        dedupeKey,
        partsSent: error.partsSent,
        totalParts: error.totalParts,
      });
      await recordDedupeCompletion(
        options.dedupeRepo,
        options.logger,
        dedupeKey,
        PARTIAL_SEND_NOTICE,
      );
    }
    return;
  }

  await recordDedupeCompletion(options.dedupeRepo, options.logger, dedupeKey, resultText);
}

/**
 * The one place a failure becomes user-visible text: a budget rejection gets
 * its own fixed string, anything else the generic one. The error itself is
 * logged, never sent.
 */
async function replyWithFailureNotice(
  options: CreateCompletionHandlerOptions,
  message: InboundMessage,
  channelUserId: number,
  error: unknown,
): Promise<void> {
  const { channel, logger } = options;

  if (error instanceof BudgetExceededError) {
    logger.error("llm completion rejected, monthly budget exceeded", {
      channelUserId,
      capUsd: error.capUsd,
      spentUsd: error.spentUsd,
    });
    await channel.send(message.chatId, OUT_OF_BUDGET_REPLY);
    return;
  }

  logger.error("llm completion failed", {
    channelUserId,
    error: error instanceof Error ? error.message : String(error),
  });
  await channel.send(message.chatId, GENERIC_FAILURE_REPLY);
}

/**
 * `createCompletionHandler({ channel, agent, logger, dedupeRepo })` →
 * `(message) => Promise<void>`: one `agent.handleMessage()` turn per
 * Telegram message, reply with its text. The agent loop
 * (`packages/agent`, 2c) owns multi-turn history, the tool loop (Phase 2),
 * and the approval gate (Phase 3) — this handler stays thin: claim, call,
 * reply, complete. A thrown error from the agent turn is caught and
 * replaced with a generic readable reply instead of crashing the handler.
 *
 * Ordering, load-bearing: `claim()` -> (if already `completed`) reply from
 * the stored text, skip the agent turn entirely -> otherwise run the turn ->
 * reply -> `complete()`. `complete()` runs strictly after the reply is
 * sent: recording completion first would mark a call "done" the user never
 * actually received. See packages/store/README.md for the claim-to-complete
 * crash window this ordering accepts as a narrow, fail-open residual risk.
 */
export function createCompletionHandler(
  options: CreateCompletionHandlerOptions,
): (message: InboundMessage, args?: string) => Promise<void> {
  const { channel, logger, dedupeRepo } = options;

  return async function handleCompletion(message: InboundMessage, _args?: string): Promise<void> {
    const channelUserId = Number(message.channelUserId);

    if (message.kind === "edited_message") {
      logger.info("edited message ignored", { channelUserId });
      return;
    }

    const dedupeKey = deriveDedupeKey(message);

    try {
      const claimResult = await dedupeRepo.claim(dedupeKey);
      if (claimResult.status === "completed") {
        await channel.send(message.chatId, claimResult.resultText);
        return;
      }

      await replyWithCompletion(options, message, dedupeKey);
    } catch (error) {
      await replyWithFailureNotice(options, message, channelUserId, error);
    }
  };
}
