import type { Logger } from "@hermes/core";
import type {
  Channel,
  ChannelCapabilities,
  InboundMessage,
  InboundMessageHandler,
} from "../channel";
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "./client";

const POLL_TIMEOUT_SECONDS = 30;
const POLL_LIMIT = 100;
const ALLOWED_UPDATES = ["message", "edited_message"] as const;
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
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}

/** A Telegram `Channel` plus graceful-shutdown control. */
export interface TelegramPoller extends Channel {
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
  const { client, logger, offsetRepo, onFatalError } = options;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let handler: InboundMessageHandler | undefined;
  let offset: number | undefined;
  let stopping = false;
  let loopPromise: Promise<void> = Promise.resolve();

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = normalizeTelegramUpdate(update, logger);
    if (message && handler) {
      await handler(message);
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
    async send(target, text) {
      await client.sendMessage(target, text);
    },
    async stop() {
      stopping = true;
      await loopPromise;
    },
  };
}
