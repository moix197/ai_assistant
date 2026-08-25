import type { Logger } from "@hermes/core";
import type {
  Channel,
  ChannelCapabilities,
  InboundMessage,
  InboundMessageHandler,
} from "../channel";
import type { TelegramClient, TelegramMessage, TelegramUpdate } from "./client";

const POLL_TIMEOUT_SECONDS = 30;
const POLL_LIMIT = 100;
const ALLOWED_UPDATES = ["message", "edited_message"] as const;
/** Fixed short delay before retrying after a transient getUpdates failure. Structured backoff is Phase 4. */
const RETRY_DELAY_MS = 3_000;

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

export interface TelegramPollerOptions {
  client: TelegramClient;
  logger: Logger;
}

/**
 * Long-poll loop against `getUpdates`. In-memory offset only at this phase —
 * no persistence, no advisory lock, no structured backoff (Phase 3/4). On a
 * transient fetch error this logs and retries after a fixed short delay
 * rather than re-throwing, since a crashed poller silently stops the bot.
 */
export function createTelegramPoller(options: TelegramPollerOptions): Channel {
  const { client, logger } = options;
  let handler: InboundMessageHandler | undefined;
  let offset: number | undefined;

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    offset = update.update_id + 1;
    const message = normalizeTelegramUpdate(update, logger);
    if (message && handler) {
      await handler(message);
    }
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
      logger.warn("getUpdates failed, retrying", {
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(RETRY_DELAY_MS);
      return;
    }

    for (const update of updates) {
      await handleUpdate(update);
    }
  }

  // Runs for the process lifetime; graceful stop/drain is Phase 4.
  async function loop(): Promise<void> {
    while (true) {
      await pollOnce();
    }
  }

  return {
    capabilities: TELEGRAM_CAPABILITIES,
    subscribe(inboundHandler) {
      handler = inboundHandler;
      void loop();
    },
    async send(target, text) {
      await client.sendMessage(target, text);
    },
  };
}
