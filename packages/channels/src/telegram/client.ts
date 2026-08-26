import { nextDelay } from "./backoff";
import { chunkText } from "./chunk";

/**
 * Raw-`fetch` Telegram Bot API client. No telegraf/grammy — per the
 * dependency policy, `getUpdates`/`sendMessage` are the only two methods this
 * PRD needs, and wrapping them in a generated SDK covering the entire API
 * surface would be a mega-package for two endpoints.
 *
 * Token redaction: Telegram embeds the bot token in the URL *path*
 * (`/bot<token>/<method>`), not in an `Authorization` header, so nothing
 * redacts it automatically the way a header-based scheme would. Every
 * thrown error's message is redacted before it leaves this module, on every
 * code path — including the network-failure path, where the raw URL most
 * often leaks via the underlying fetch error's message.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REDACTED_TOKEN = "<REDACTED>";

/** Client-side timeout margin added on top of the poll `timeout`. See getUpdates(). */
const TIMEOUT_MARGIN_MS = 10_000;
const SEND_MESSAGE_TIMEOUT_MS = 10_000;
const DELETE_WEBHOOK_TIMEOUT_MS = 10_000;

/** HTTP 429 (rate limited): retry_after is authoritative, but still bounded so a persistent limiter can't hang shutdown. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** HTTP 409 (another getUpdates consumer active): a few bounded retries then fatal, per the plan. */
const MAX_CONFLICT_RETRIES = 3;
/** 5xx and network/timeout errors: bounded exponential backoff, then rethrow to the poller's own retry loop. */
const MAX_TRANSIENT_RETRIES = 5;

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

/** Carries the HTTP status and Telegram's own error fields so the retry policy can decide what to do without re-parsing the message string. */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly errorCode?: number;
  readonly retryAfter?: number;

  constructor(message: string, info: { status: number; errorCode?: number; retryAfter?: number }) {
    super(message);
    this.name = "TelegramApiError";
    this.status = info.status;
    this.errorCode = info.errorCode;
    this.retryAfter = info.retryAfter;
  }
}

function redact(value: string, token: string): string {
  return value.split(token).join(REDACTED_TOKEN);
}

function buildUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function parseErrorBody(rawText: string): {
  error_code?: number;
  parameters?: { retry_after?: number };
} {
  try {
    return JSON.parse(rawText) as { error_code?: number; parameters?: { retry_after?: number } };
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single attempt at one Telegram API call. Throws `TelegramApiError` for any
 * API-level failure (HTTP not ok, or `ok: false` in the payload) carrying
 * enough structure for `callWithRetry` to decide whether to retry, or a
 * plain redacted `Error` for a network/timeout failure. Every message is
 * redacted before it leaves this function on every path.
 *
 * `getUpdates` is a long-poll: Telegram holds the connection open for up to
 * `params.timeout` seconds waiting for a message. The client-side abort
 * timeout must exceed that, or this client aborts (and the caller retries)
 * while Telegram is still legitimately waiting.
 */
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
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Telegram request to ${redactedUrl} failed: ${redact(message, token)}`);
    }

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      const parsed = parseErrorBody(rawText);
      throw new TelegramApiError(
        `Telegram API returned HTTP ${response.status} calling ${redactedUrl}: ${redact(rawText, token)}`,
        {
          status: response.status,
          errorCode: parsed.error_code,
          retryAfter: parsed.parameters?.retry_after,
        },
      );
    }

    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      const description = redact(payload.description ?? "unknown error", token);
      throw new TelegramApiError(
        `Telegram API rejected the call to ${redactedUrl}: ${description}`,
        {
          status: response.status,
          errorCode: payload.error_code,
          retryAfter: payload.parameters?.retry_after,
        },
      );
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps `callTelegramMethod` with the retry policy: 429 waits for
 * `retry_after` (falling back to computed backoff if absent); 409 (another
 * `getUpdates` consumer) gets a few bounded retries then rethrows, since
 * that's a real conflict, not a transient blip; 5xx and network/timeout
 * errors back off exponentially, bounded, then rethrow to the caller's own
 * retry loop (the poller logs and retries on a fixed delay). Any other
 * status (e.g. 400/401) is not retryable and rethrows immediately. Retrying
 * the exact same `body` means a retried `getUpdates` call reuses the same
 * offset automatically — it was never mutated here.
 */
async function callWithRetry<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  let rateLimitAttempt = 0;
  let conflictAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    try {
      return await callTelegramMethod<T>(fetchImpl, token, method, body, timeoutMs);
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.status === 429) {
          rateLimitAttempt++;
          if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) throw error;
          await delay(nextDelay(rateLimitAttempt, error.retryAfter));
          continue;
        }
        if (error.status === 409) {
          conflictAttempt++;
          if (conflictAttempt > MAX_CONFLICT_RETRIES) {
            // A 409 that survives bounded retries means another process is
            // holding this bot token's getUpdates stream long-term, not a
            // transient blip — rethrow with a readable, actionable message
            // instead of leaving the caller to decode an HTTP status.
            throw new TelegramApiError(
              `Telegram getUpdates conflict (409) persisted after ${MAX_CONFLICT_RETRIES} retries: ` +
                `another instance is already polling with this bot token. ${error.message}`,
              { status: error.status, errorCode: error.errorCode, retryAfter: error.retryAfter },
            );
          }
          await delay(nextDelay(conflictAttempt));
          continue;
        }
        if (error.status >= 500) {
          transientAttempt++;
          if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
          await delay(nextDelay(transientAttempt));
          continue;
        }
        throw error;
      }

      transientAttempt++;
      if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
      await delay(nextDelay(transientAttempt));
    }
  }
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const { token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async getUpdates(params) {
      const timeoutMs = params.timeout * 1000 + TIMEOUT_MARGIN_MS;
      return callWithRetry<TelegramUpdate[]>(
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
      // Chunked before sending so any long output (starting with /ping's
      // text) is safe by construction, not by caller discipline. Parts are
      // sent in order, awaited one at a time, to preserve message order.
      for (const part of chunkText(text)) {
        await callWithRetry<TelegramMessage>(
          fetchImpl,
          token,
          "sendMessage",
          { chat_id: chatId, text: part },
          SEND_MESSAGE_TIMEOUT_MS,
        );
      }
    },

    async deleteWebhook() {
      await callWithRetry<boolean>(
        fetchImpl,
        token,
        "deleteWebhook",
        {},
        DELETE_WEBHOOK_TIMEOUT_MS,
      );
    },
  };
}
