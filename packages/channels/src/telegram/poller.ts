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
   * `pollOnce()` iteration — and every message dispatch still detached from
   * that iteration (see `dispatchMessage`) has settled. Does not itself
   * impose a timeout; callers (boot.ts) bound how long they wait for this to
   * settle.
   */
  stop(): Promise<void>;
}

/** True for a raw update carrying a `callback_query`, false for a message/edited_message one. */
function isCallbackUpdate(update: TelegramUpdate): boolean {
  return update.callback_query !== undefined;
}

/**
 * Long-poll loop against `getUpdates`. The offset is loaded from
 * `offsetRepo` once at start. A `callback_query` update is still awaited
 * inline and its offset persisted only after its handler completes (see
 * `handleCallback`) — those are fast and must keep crash-replay semantics.
 * A message update is dispatched without the loop awaiting it, and its
 * offset advances immediately (see `dispatchMessage`): a completion handler
 * can await a Telegram approval tap for minutes, and if the loop awaited
 * that inline, `getUpdates` would never run again to fetch the very
 * `callback_query` that unblocks it. On a transient fetch error this logs
 * and retries after a fixed delay rather than re-throwing, since a crashed
 * poller silently stops the bot; `client.ts` already absorbs most transient
 * failures via structured backoff before one reaches here.
 */
export function createTelegramPoller(options: TelegramPollerOptions): TelegramPoller {
  const { client, logger, offsetRepo, onFatalError, signal } = options;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let handler: InboundMessageHandler | undefined;
  let callbackHandler: InboundCallbackHandler | undefined;
  let offset: number | undefined;
  let stopping = false;
  let loopPromise: Promise<void> = Promise.resolve();
  // Message dispatches detached from the poll loop (see `dispatchMessage`),
  // tracked here purely so `stop()` can drain them before resolving —
  // nothing else ever awaits this set.
  const inFlightDispatches = new Set<Promise<void>>();

  async function handleCallback(update: TelegramUpdate): Promise<void> {
    const callback = normalizeTelegramCallback(update, logger);
    if (callback && callbackHandler) {
      await callbackHandler(callback);
    }
  }

  /**
   * Runs a message update's handler WITHOUT the poll loop awaiting it — see
   * this function's rationale on `createTelegramPoller`'s own doc comment.
   * Declared `async` (rather than chaining `.catch` around a direct call) so
   * even a *synchronous* throw from `handler` becomes a rejection this
   * function catches itself, instead of escaping to `pollOnce`'s loop as an
   * exception that would (wrongly, under this model) stop the batch.
   *
   * By the time this settles, `pollOnce` has already advanced the offset
   * past this update (see the main loop below) — there is no redelivery to
   * fall back on the way there is for a `callback_query` failure, so a
   * rejection here is terminal for this update: logged loudly rather than
   * silently swallowed. `apps/hermes/src/handlers/complete.ts`'s dedupe
   * machinery is what now guards the redelivery side; see
   * `packages/channels/README.md`.
   */
  async function dispatchMessage(update: TelegramUpdate): Promise<void> {
    try {
      const message = normalizeTelegramUpdate(update, logger);
      if (!message || !handler) return;
      await handler(message);
    } catch (error) {
      logger.error("message handler failed after its offset was already advanced, not retried", {
        updateId: update.update_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function trackDispatch(dispatched: Promise<void>): void {
    inFlightDispatches.add(dispatched);
    void dispatched.finally(() => inFlightDispatches.delete(dispatched));
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
        // A callback_query is still awaited inline — it's fast, and the
        // approval gate's replay-on-crash behavior depends on its offset
        // only advancing once its handler has actually run. A message is
        // dispatched without waiting (see `dispatchMessage`): the offset
        // below advances immediately, before its handler even starts,
        // deliberately trading message crash-replay for never blocking this
        // loop on a handler that itself waits on a Telegram reply (the
        // approval gate) — see packages/channels/README.md.
        if (isCallbackUpdate(update)) {
          await handleCallback(update);
        } else {
          trackDispatch(dispatchMessage(update));
        }
        const nextOffset = update.update_id + 1;
        await offsetRepo.setOffset(nextOffset);
        offset = nextOffset;
      } catch (error) {
        // Only a callback_query's handleCallback (or offsetRepo.setOffset
        // itself) can land here now — dispatchMessage never rethrows, it
        // logs its own failures (see above). Offset was not advanced for
        // this update, so it (and every update after it in this batch) is
        // re-delivered by the next getUpdates call rather than silently
        // skipped — stop this batch here instead of continuing on to
        // updates whose offset advance would leapfrog the one that just
        // failed.
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
  // is still awaited before the loop exits — a pending callback_query
  // handler included, a detached message dispatch not (see `stop()`, which
  // drains those separately).
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
      // Drains dispatches detached by the current (now-finished) loop
      // iteration. `dispatchMessage` catches its own errors, so none of
      // these should reject in practice — `allSettled` over `all` anyway,
      // so one dispatch that somehow does reject can never make this drain
      // (and shutdown itself) reject instead of resolving. Snapshot the set
      // before awaiting: `trackDispatch`'s `.finally` mutates it as each one
      // settles, and iterating a Set that's being deleted from while
      // iterating is fine in JS but would otherwise make the intent read as
      // more fragile than it is.
      await Promise.allSettled([...inFlightDispatches]);
    },
  };
}
