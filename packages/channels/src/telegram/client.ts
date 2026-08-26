/**
 * Raw-`fetch` Telegram Bot API client. No telegraf/grammy — per the
 * dependency policy, `getUpdates`/`sendMessage` are the only two methods this
 * PRD needs, and wrapping them in a generated SDK covering the entire API
 * surface would be a mega-package for two endpoints.
 *
 * Token redaction: Telegram embeds the bot token in the URL *path*
 * (`/bot<token>/<method>`), not in an `Authorization` header, so nothing
 * redacts it automatically the way a header-based scheme would. Every
 * thrown error's message is passed through `redact()` before it leaves this
 * module, on every code path — including the network-failure path, where the
 * raw URL most often leaks via the underlying fetch error's message.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REDACTED_TOKEN = "<REDACTED>";

/** Client-side timeout margin added on top of the poll `timeout`. See getUpdates(). */
const TIMEOUT_MARGIN_MS = 10_000;
const SEND_MESSAGE_TIMEOUT_MS = 10_000;
const DELETE_WEBHOOK_TIMEOUT_MS = 10_000;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface GetUpdatesParams {
  offset?: number;
  timeout: number;
  limit: number;
  allowedUpdates: readonly string[];
}

export interface TelegramClient {
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string | number, text: string): Promise<void>;
  /**
   * Deletes any webhook registered for this bot token. `getUpdates`
   * long-polling and a webhook are mutually exclusive on Telegram's side, so
   * this is called unconditionally at every boot (see boot.ts) — cheap and
   * idempotent even when no webhook was ever set.
   */
  deleteWebhook(): Promise<void>;
}

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

function redact(value: string, token: string): string {
  return value.split(token).join(REDACTED_TOKEN);
}

function buildUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

/** Wraps any thrown value into an Error whose message never contains the raw token. */
function toRedactedError(error: unknown, token: string, redactedUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Telegram request to ${redactedUrl} failed: ${redact(message, token)}`);
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function callTelegramMethod<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const url = buildUrl(token, method);
  const redactedUrl = redact(url, token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      throw new Error(
        `Telegram API returned HTTP ${response.status} calling ${redactedUrl}: ${redact(rawText, token)}`,
      );
    }

    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      throw new Error(
        `Telegram API rejected the call to ${redactedUrl}: ${payload.description ?? "unknown error"}`,
      );
    }
    return payload.result;
  } catch (error) {
    throw toRedactedError(error, token, redactedUrl);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `getUpdates` is a long-poll: Telegram holds the connection open for up to
 * `params.timeout` seconds waiting for a message. The client-side abort
 * timeout must exceed that, or this client aborts (and the poller retries)
 * while Telegram is still legitimately waiting — the single most important
 * correctness detail here beyond the offset rule. `+ 10s` is a fixed margin,
 * not a percentage, so it stays meaningfully larger than the poll timeout at
 * any value.
 */
export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const { token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async getUpdates(params) {
      const timeoutMs = params.timeout * 1000 + TIMEOUT_MARGIN_MS;
      return callTelegramMethod<TelegramUpdate[]>(
        fetchImpl,
        token,
        "getUpdates",
        {
          offset: params.offset,
          timeout: params.timeout,
          limit: params.limit,
          allowed_updates: params.allowedUpdates,
        },
        timeoutMs,
      );
    },

    async sendMessage(chatId, text) {
      await callTelegramMethod<TelegramMessage>(
        fetchImpl,
        token,
        "sendMessage",
        { chat_id: chatId, text },
        SEND_MESSAGE_TIMEOUT_MS,
      );
    },

    async deleteWebhook() {
      await callTelegramMethod<boolean>(
        fetchImpl,
        token,
        "deleteWebhook",
        {},
        DELETE_WEBHOOK_TIMEOUT_MS,
      );
    },
  };
}
