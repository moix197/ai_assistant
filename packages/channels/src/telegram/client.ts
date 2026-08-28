import { delay, nextDelay } from "@hermes/core";
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
const ANSWER_CALLBACK_QUERY_TIMEOUT_MS = 10_000;
const EDIT_MESSAGE_TEXT_TIMEOUT_MS = 10_000;

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

/** The tap payload Telegram sends for an inline-keyboard button press. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** The message the tapped button was attached to — absent for very old/inaccessible messages, per Telegram's API. */
  message?: TelegramMessage;
  /** The button's `callback_data`, absent only for a button that carried none (never the case for a button this codebase sends). */
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** One row of an inline keyboard's buttons, in Telegram's own wire shape. */
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface SendMessageOptions {
  replyMarkup?: TelegramReplyMarkup;
}

export interface GetUpdatesParams {
  offset?: number;
  timeout: number;
  limit: number;
  allowedUpdates: readonly string[];
  /**
   * The boot-lifetime shutdown signal (see `apps/hermes/src/boot.ts`),
   * composed with — not a replacement for — this client's own per-request
   * timeout below, so an idle long-poll aborts promptly on shutdown instead
   * of running out its full timeout.
   */
  signal?: AbortSignal;
}

export interface TelegramClient {
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  /**
   * Returns the id of the message actually sent — when `text` is chunked
   * into multiple parts (see `chunk.ts`), that's the *last* part's id, and
   * `options.replyMarkup` (when given) is attached to that last part only,
   * so a keyboard never appears mid-message on a long send.
   */
  sendMessage(
    chatId: string | number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ messageId: number }>;
  /**
   * Deletes any webhook registered for this bot token. `getUpdates`
   * long-polling and a webhook are mutually exclusive on Telegram's side, so
   * this is called unconditionally at every boot (see boot.ts) — cheap and
   * idempotent even when no webhook was ever set.
   */
  deleteWebhook(): Promise<void>;
  /** Acknowledges a `callback_query` — Telegram requires every one to be answered, with or without a visible toast (`text`). */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Edits a previously sent message's text in place — used to make a resolved approval prompt's buttons inert. */
  editMessageText(chatId: string | number, messageId: number, text: string): Promise<void>;
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
 *
 * `externalSignal`, when supplied, is not composed via `AbortSignal.any` —
 * Node 22 never releases a dependent signal from a composite `AbortSignal`
 * it created, so a new composite retained per ~30s long-poll call leaks
 * (measured ~2.5KB each, ~210MB/month for a long-running bot). Instead,
 * `externalSignal` gets an `abort` listener that aborts this call's own
 * `timeoutController` — the single signal actually passed to `fetch` — and
 * that listener is removed in the `finally` block below so nothing survives
 * past this call. Either `externalSignal` firing or the per-request timeout
 * elapsing still aborts the underlying `fetch`.
 */
async function callTelegramMethod<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const url = buildUrl(token, method);
  const redactedUrl = redact(url, token);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onExternalAbort = () => timeoutController.abort();
  // `addEventListener` never fires for a signal already aborted before the
  // listener was attached, so that case is handled explicitly here instead.
  if (externalSignal?.aborted) {
    timeoutController.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
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
    externalSignal?.removeEventListener("abort", onExternalAbort);
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
 *
 * `externalSignal?.aborted` is checked first, ahead of any error-type
 * classification (mirrors `packages/llm`'s `completeWithRetry`): a shutdown
 * pre-empts every retry policy below, since retrying would defeat the point
 * of a prompt shutdown. That check alone only covers a signal already
 * aborted by the time an attempt fails; the backoff sleep itself is the
 * abort-aware `delay(ms, signal)` from `@hermes/core` (shared with
 * `packages/llm`), so a shutdown landing mid-sleep resolves it immediately
 * instead of burning a full `retry_after`/computed backoff before the check
 * above ever runs again.
 */
async function callWithRetry<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  let rateLimitAttempt = 0;
  let conflictAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    try {
      return await callTelegramMethod<T>(fetchImpl, token, method, body, timeoutMs, externalSignal);
    } catch (error) {
      if (externalSignal?.aborted) throw error;
      if (error instanceof TelegramApiError) {
        if (error.status === 429) {
          rateLimitAttempt++;
          if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) throw error;
          await delay(nextDelay(rateLimitAttempt, error.retryAfter), externalSignal);
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
          await delay(nextDelay(conflictAttempt), externalSignal);
          continue;
        }
        if (error.status >= 500) {
          transientAttempt++;
          if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
          await delay(nextDelay(transientAttempt), externalSignal);
          continue;
        }
        throw error;
      }

      transientAttempt++;
      if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
      await delay(nextDelay(transientAttempt), externalSignal);
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
        params.signal,
      );
    },

    async sendMessage(chatId, text, options) {
      // Chunked before sending so any long output (starting with /ping's
      // text) is safe by construction, not by caller discipline. Parts are
      // sent in order, awaited one at a time, to preserve message order.
      // A caller-supplied keyboard is attached only to the last part, so it
      // never appears mid-message on a long send.
      const parts = chunkText(text);
      let lastMessage: TelegramMessage | undefined;
      for (let index = 0; index < parts.length; index++) {
        const isLast = index === parts.length - 1;
        const body: Record<string, unknown> = { chat_id: chatId, text: parts[index] };
        if (isLast && options?.replyMarkup) {
          body.reply_markup = options.replyMarkup;
        }
        lastMessage = await callWithRetry<TelegramMessage>(
          fetchImpl,
          token,
          "sendMessage",
          body,
          SEND_MESSAGE_TIMEOUT_MS,
        );
      }
      // `parts` is never empty — chunkText always returns at least one part,
      // even for an empty string — so lastMessage is always assigned here.
      if (!lastMessage) {
        throw new Error(
          "sendMessage produced no parts; chunkText should never return an empty array",
        );
      }
      return { messageId: lastMessage.message_id };
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

    async answerCallbackQuery(callbackQueryId, text) {
      await callWithRetry<boolean>(
        fetchImpl,
        token,
        "answerCallbackQuery",
        { callback_query_id: callbackQueryId, ...(text !== undefined ? { text } : {}) },
        ANSWER_CALLBACK_QUERY_TIMEOUT_MS,
      );
    },

    async editMessageText(chatId, messageId, text) {
      await callWithRetry<TelegramMessage>(
        fetchImpl,
        token,
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text },
        EDIT_MESSAGE_TEXT_TIMEOUT_MS,
      );
    },
  };
}
