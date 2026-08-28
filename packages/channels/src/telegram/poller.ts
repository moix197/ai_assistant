import { type Logger, delay } from "@hermes/core";
import type {
  Channel,
  ChannelCapabilities,
  InboundCallback,
  InboundCallbackHandler,
  InboundMessage,
  InboundMessageHandler,
  SendOptions,
} from "../channel";
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "./client";

const POLL_TIMEOUT_SECONDS = 30;
const POLL_LIMIT = 100;
const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"] as const;
/** Default fixed delay before retrying after a transient getUpdates/handler failure. Overridable via TelegramPollerOptions.retryDelayMs so tests don't have to wait out the real value. */
const DEFAULT_RETRY_DELAY_MS = 3_000;

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  markdown: true,
  files: true,
  buttons: true,
  maxMessageLength: 4096,
};

function toChatType(rawType: string): InboundMessage["chatType"] {
  if (rawType === "private") return "private";
  if (rawType === "group" || rawType === "supergroup") return "group";
  return "other";
}

/**
 * Converts a raw Telegram update into the channel-neutral `InboundMessage`
 * shape, or returns `null` when it can't. An update with no `message.from`
 * (channel posts, some anonymous-admin group messages) has no user id to
 * check against the allowlist — proceeding without one would be fail-open,
 * so it's dropped here, before any handler ever sees it, and logged at
 * debug only (it's expected background noise, not an actionable warning).
 */
export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  logger: Logger,
): InboundMessage | null {
  const kind: InboundMessage["kind"] = update.message ? "message" : "edited_message";
  const message: TelegramMessage | undefined = update.message ?? update.edited_message;

  if (!message) return null;

  if (!message.from) {
    logger.debug("dropped update with no message.from", { updateId: update.update_id });
    return null;
  }

  return {
    channelUserId: String(message.from.id),
    chatId: String(message.chat.id),
    text: message.text ?? "",
    chatType: toChatType(message.chat.type),
    kind,
    updateId: update.update_id,
  };
}

/**
 * Converts a raw `callback_query` update into the channel-neutral
 * `InboundCallback` shape, or `null` when it can't (no `callback_query` at
 * all, or one missing the message/data this codebase's only caller —
 * the approval gate — always needs). Mirrors `normalizeTelegramUpdate`'s
 * fail-closed shape: dropped and logged at debug, never thrown.
 */
export function normalizeTelegramCallback(
  update: TelegramUpdate,
  logger: Logger,
): InboundCallback | null {
  const callback = update.callback_query;
  if (!callback) return null;

  if (!callback.message || callback.data === undefined) {
    logger.debug("dropped callback_query with no message or data", { updateId: update.update_id });
    return null;
  }

  return {
    callbackId: callback.id,
    callbackData: callback.data,
    chatId: String(callback.message.chat.id),
    messageId: String(callback.message.message_id),
    channelUserId: String(callback.from.id),
  };
}

/**
 * Persistence port for the poller's offset — a small interface rather than a
 * direct `@hermes/store` dependency, so this package stays decoupled from
 * Postgres and the poller stays testable with a mock. `boot.ts` wires this to
 * `@hermes/store`'s `getOffset(pool)`/`setOffset(pool, updateId)`.
 */
export interface TelegramOffsetRepo {
  getOffset(): Promise<number>;
  setOffset(updateId: number): Promise<void>;
}

export interface TelegramPollerOptions {
  client: TelegramClient;
  logger: Logger;
  offsetRepo: TelegramOffsetRepo;
  /** Delay before retrying after a transient getUpdates/handler failure. Default DEFAULT_RETRY_DELAY_MS. */
  retryDelayMs?: number;
  /**
   * Called when the poller hits an error it must not retry forever — today,
   * a 409 that already exhausted `client.ts`'s own bounded retries, meaning
   * another instance holds this bot token's getUpdates stream long-term.
   * Retrying that on a fixed delay indefinitely is exactly the
   * mystery-failure mode this PRD exists to eliminate, so the loop stops
   * itself and hands the error to the caller (boot.ts) instead.
   */
  onFatalError?: (error: Error) => void;
  /**
   * The boot-lifetime shutdown signal (see `apps/hermes/src/boot.ts`),
   * threaded into every `getUpdates` call so an in-flight long-poll aborts
   * promptly when shutdown fires, instead of `stop()`'s drain wait always
   * running out the caller's backstop timeout. Optional: tests exercise the
   * poller without wiring one.
   */
  signal?: AbortSignal;
}

/**
 * A Telegram `Channel` plus graceful-shutdown control. Narrows `Channel`'s
 * optional Phase-3 members (`subscribeCallback`/`editMessage`/
 * `answerCallback`) to required, since the real Telegram implementation
 * always provides them — only a mock `Channel` built before inline keyboards
 * existed is allowed to omit them.
 */
export interface TelegramPoller extends Channel {
  subscribeCallback(handler: InboundCallbackHandler): void;
  editMessage(target: string, messageId: string, text: string): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /**
   * Flips the loop's stopping flag so no new `getUpdates` call starts, then
   * resolves once the loop has actually exited — including any in-flight
   * `pollOnce()` iteration. Does not itself impose a timeout; callers
   * (boot.ts) bound how long they wait for this to settle.
   */
  stop(): Promise<void>;
}

/**
 * Long-poll loop against `getUpdates`. The offset is loaded from
 * `offsetRepo` once at start and persisted after each update is fully
 * handled. On a transient fetch error this logs and retries after a fixed
 * delay rather than re-throwing, since a crashed poller silently stops the
 * bot; `client.ts` already absorbs most transient failures via structured
 * backoff before one reaches here.
 */
export function createTelegramPoller(options: TelegramPollerOptions): TelegramPoller {
  const { client, logger, offsetRepo, onFatalError, signal } = options;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let handler: InboundMessageHandler | undefined;
  let callbackHandler: InboundCallbackHandler | undefined;
  let offset: number | undefined;
  let stopping = false;
  let loopPromise: Promise<void> = Promise.resolve();

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = normalizeTelegramUpdate(update, logger);
    if (message && handler) {
      await handler(message);
    }
    const callback = normalizeTelegramCallback(update, logger);
    if (callback && callbackHandler) {
      await callbackHandler(callback);
    }
    const nextOffset = update.update_id + 1;
    // Persisted only *after* the handler has fully completed: Telegram
    // permanently deletes an update once its id is acked via `offset`, so
    // persisting before (or without) handling it risks losing that update
    // forever if the process crashes in between. A crash between the
    // handler resolving and this line replays exactly this one update on
    // restart — see poller-crash-replay.test.ts and packages/channels/README.md.
    await offsetRepo.setOffset(nextOffset);
    offset = nextOffset;
  }

  async function pollOnce(): Promise<void> {
    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates({
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        limit: POLL_LIMIT,
        allowedUpdates: ALLOWED_UPDATES,
        signal,
      });
    } catch (error) {
      // A 409 that already exhausted client.ts's own bounded retries is a
      // permanent conflict (another instance holds the poll stream), not a
      // transient blip — retrying it forever on a fixed delay would hide
      // exactly the failure mode this PRD exists to surface. Stop the loop
      // and hand it to the caller instead of looping.
      if (error instanceof TelegramApiError && error.status === 409) {
        logger.error("fatal: telegram getUpdates conflict, stopping poller", {
          error: error.message,
        });
        stopping = true;
        onFatalError?.(error);
        return;
      }

      // `stop()` sets `stopping` before this catch can run (see boot.ts's
      // shutdown(): controller.abort() then channel.stop() happen
      // synchronously back to back, with no await between them), so a
      // getUpdates rejection caused by the shared shutdown signal always
      // observes `stopping === true` here. Checking `signal?.aborted` too
      // covers the case where the signal aborts without `stop()` ever being
      // called: without this, the loop would misreport a deliberate
      // shutdown as a transport failure and spin warn + a full retryDelayMs
      // forever, since `stopping` would never flip on its own.
      if (signal?.aborted || stopping) {
        stopping = true;
        logger.info("poll aborted for shutdown");
        return;
      }

      logger.warn("getUpdates failed, retrying", {
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(retryDelayMs);
      return;
    }

    for (const update of updates) {
      try {
        await handleUpdate(update);
      } catch (error) {
        // Offset was not advanced for this update, so it (and every update
        // after it in this batch) is re-delivered by the next getUpdates
        // call rather than silently skipped — stop this batch here instead
        // of continuing on to updates whose offset advance would leapfrog
        // the one that just failed.
        logger.warn("handler failed, will retry this update", {
          updateId: update.update_id,
          error: error instanceof Error ? error.message : String(error),
        });
        await delay(retryDelayMs);
        return;
      }
    }
  }

  // Runs until stop() flips `stopping`; the in-flight pollOnce() iteration
  // (including its handler) is still awaited before the loop exits.
  async function loop(): Promise<void> {
    offset = await offsetRepo.getOffset();
    while (!stopping) {
      await pollOnce();
    }
  }

  return {
    capabilities: TELEGRAM_CAPABILITIES,
    subscribe(inboundHandler) {
      handler = inboundHandler;
      loopPromise = loop();
    },
    subscribeCallback(inboundCallbackHandler) {
      callbackHandler = inboundCallbackHandler;
    },
    async send(target, text, sendOptions?: SendOptions) {
      const replyMarkup = sendOptions?.buttons
        ? {
            inline_keyboard: sendOptions.buttons.map((row) =>
              row.map((button) => ({ text: button.label, callback_data: button.callbackData })),
            ),
          }
        : undefined;
      const { messageId } = await client.sendMessage(
        target,
        text,
        replyMarkup ? { replyMarkup } : undefined,
      );
      return { messageId: String(messageId) };
    },
    async editMessage(target, messageId, text) {
      await client.editMessageText(target, Number(messageId), text);
    },
    async answerCallback(callbackId, text) {
      await client.answerCallbackQuery(callbackId, text);
    },
    async stop() {
      stopping = true;
      await loopPromise;
    },
  };
}
