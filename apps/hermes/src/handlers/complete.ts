import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { BudgetExceededError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";
import type { LlmDedupeClaimResult } from "@hermes/store";

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

/**
 * Fixed placeholder — no persona/tool instructions beyond this string.
 * Anything richer belongs to `packages/agent` (2c), not this phase's
 * single-shot proof of life.
 */
const SYSTEM_PROMPT_PLACEHOLDER = "You are Hermes, a helpful assistant.";

/** Never leaks a stack trace or provider error detail into chat. */
const GENERIC_FAILURE_REPLY =
  "Sorry, I couldn't process that message right now. Please try again in a moment.";

/**
 * Distinct from `GENERIC_FAILURE_REPLY`: a deliberate, fixed string, never
 * `BudgetExceededError.message` — that message carries `capUsd`/`spentUsd`,
 * useful in boot logs but not something to leak to chat by default. Spend
 * figures surface to users via `/stats` (02-telemetry), not here.
 */
const OUT_OF_BUDGET_REPLY =
  "Hermes is out of budget for this month. Please try again after the monthly reset.";

export interface CreateCompletionHandlerOptions {
  channel: Channel;
  llmProvider: LlmProvider;
  /** The model to request — the active provider profile's `model` (see `build-provider-profiles.ts`). */
  model: string;
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
  return `telegram:${message.updateId}`;
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
 * `createCompletionHandler({ channel, llmProvider, model, logger, dedupeRepo })`
 * → `(message) => Promise<void>`: one `complete()` call per Telegram
 * message, reply with `result.text`. No tool loop, no approval gate, no
 * persistence beyond dedupe — that's `packages/agent` (2c)'s bounded
 * agentic loop, not this phase's. A thrown provider error is caught and
 * replaced with a generic readable reply instead of crashing the handler.
 *
 * Ordering, load-bearing: `claim()` -> (if already `completed`) reply from
 * the stored text, skip the provider call entirely -> otherwise call the
 * provider -> reply -> `complete()`. `complete()` runs strictly after the
 * reply is sent: recording completion first would mark a call "done" the
 * user never actually received. See packages/store/README.md for the
 * claim-to-complete crash window this ordering accepts as a narrow,
 * fail-open residual risk.
 */
export function createCompletionHandler(
  options: CreateCompletionHandlerOptions,
): (message: InboundMessage) => Promise<void> {
  const { channel, llmProvider, model, logger, dedupeRepo } = options;

  return async function handleCompletion(message: InboundMessage): Promise<void> {
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

      const result = await llmProvider.complete({
        model,
        system: SYSTEM_PROMPT_PLACEHOLDER,
        messages: [{ role: "user", content: message.text }],
        tools: undefined,
        maxTokens: MAX_TOKENS_PER_TURN,
      });
      await channel.send(message.chatId, result.text);

      await recordDedupeCompletion(dedupeRepo, logger, dedupeKey, result.text);
    } catch (error) {
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
  };
}
