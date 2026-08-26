import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { BudgetExceededError, type LlmProvider, MAX_TOKENS_PER_TURN } from "@hermes/llm";

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
}

/**
 * `createCompletionHandler({ channel, llmProvider, model, logger })` →
 * `(message) => Promise<void>`: one `complete()` call per Telegram message,
 * reply with `result.text`. No tool loop, no approval gate, no persistence
 * — that's `packages/agent` (2c)'s bounded agentic loop, not this phase's.
 * A thrown provider error is caught and replaced with a generic readable
 * reply instead of crashing the handler.
 */
export function createCompletionHandler(
  options: CreateCompletionHandlerOptions,
): (message: InboundMessage) => Promise<void> {
  const { channel, llmProvider, model, logger } = options;

  return async function handleCompletion(message: InboundMessage): Promise<void> {
    const channelUserId = Number(message.channelUserId);

    if (message.kind === "edited_message") {
      logger.info("edited message ignored", { channelUserId });
      return;
    }

    try {
      const result = await llmProvider.complete({
        model,
        system: SYSTEM_PROMPT_PLACEHOLDER,
        messages: [{ role: "user", content: message.text }],
        tools: undefined,
        maxTokens: MAX_TOKENS_PER_TURN,
      });
      await channel.send(message.chatId, result.text);
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
