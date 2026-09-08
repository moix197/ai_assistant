import { withHttpRetry } from "@hermes/core";
import type { GmailMessagePart } from "./mime";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Per-request timeout for one Gmail API attempt — independent of, and
 * smaller than, the calling tool's own `ToolSpec.timeoutMs` (30s for
 * `gmail_list_unread`), which bounds the *whole* handler call including this
 * client's own retries. Mirrors `packages/google-sheets`'
 * `REQUEST_TIMEOUT_MS`.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_TRANSIENT_RETRIES = 5;

const REDACTED_TOKEN = "<REDACTED>";

function redact(value: string, accessToken: string): string {
  return value.split(accessToken).join(REDACTED_TOKEN);
}

/** Thrown for any non-ok Gmail API response. `status`/`retryAfter` (seconds, when Google sends the header) drive `classify`'s retry decision below — same shape as `SheetsApiError`/`CalendarApiError`. */
export class GmailApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null || headerValue.trim() === "") return undefined;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

type GmailRetryClass = "rateLimit" | "transient";

/**
 * A 429 means Google rejected the request before applying it — safe to
 * retry, honoring the server-supplied `Retry-After` when present. Any 5xx
 * (necessarily *after* the request was sent) is "transient" — every `GET`
 * this client makes is naturally idempotent, and the one `POST`
 * (`modifyMessage`) is idempotent by Gmail's own label semantics (Phase 3),
 * so retrying either freely within the tool's own timeout budget carries no
 * risk. Any other
 * status is fatal — thrown directly, never returned, per `@hermes/core`'s
 * `withHttpRetry` contract. This notably includes 401/403: an expired token
 * or a revoked/insufficient scope must never be retried — `insufficient-
 * scope.ts` maps it to a structured refusal instead.
 */
function classify(error: unknown): { class: GmailRetryClass; retryAfterMs?: number } {
  if (error instanceof GmailApiError) {
    if (error.status === 429) {
      return {
        class: "rateLimit",
        retryAfterMs: error.retryAfter !== undefined ? error.retryAfter * 1000 : undefined,
      };
    }
    if (error.status >= 500) return { class: "transient" };
    throw error;
  }
  // A redacted network-failure Error or a non-JSON body: both transient.
  return { class: "transient" };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const wrapped = new Error(redact(`Gmail request failed: ${message}`, accessToken), { cause });
    if (error instanceof Error && error.name === "AbortError") wrapped.name = "AbortError";
    throw wrapped;
  }

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    throw new GmailApiError(
      redact(`Gmail API returned HTTP ${response.status}: ${rawText}`, accessToken),
      response.status,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error("Gmail API response body is not valid JSON");
  }
}

/**
 * Retries `requestJson` via `@hermes/core`'s shared `withHttpRetry` — the
 * same mechanism `packages/google-sheets`'/`packages/google-calendar`'s
 * clients use. Shared by every `GET` and `POST` call this client makes: a
 * `GET` is naturally idempotent, and the one `POST` (`modifyMessage`,
 * `users.messages.modify`) is idempotent by Gmail's own semantics too
 * (adding an already-present label, or removing an already-absent one, is a
 * harmless no-op) — so both retry under the same rules with no special-casing
 * by method.
 */
async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  externalSignal: AbortSignal | undefined,
  body?: unknown,
): Promise<unknown> {
  return withHttpRetry<unknown, GmailRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal, body),
    timeoutMs: REQUEST_TIMEOUT_MS,
    externalSignal,
    classes: {
      rateLimit: { maxAttempts: MAX_RATE_LIMIT_RETRIES },
      transient: { maxAttempts: MAX_TRANSIENT_RETRIES },
    },
    classify,
  });
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListMessagesResult {
  messages: GmailMessageRef[];
  resultSizeEstimate?: number;
}

/** `q`/`labelIds` both feed `users.messages.list` — bundled into one params object rather than positional args, so a later phase's free-text search (`gmail_search`) can supply `q` without a new client method. */
export interface GmailListMessagesQuery {
  q?: string;
  labelIds?: string[];
}

/** The headers this phase asks Google for — see `getMessageMetadata` below. Only these keys can appear in a returned `GmailMessageMetadata.headers`. */
const METADATA_HEADERS = ["From", "To", "Subject", "Date", "Message-ID"];

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>;
  /** Gmail's short auto-generated preview, present on `format: "metadata"` responses too — backs `gmail_search`'s per-result `snippet`. */
  snippet: string;
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds: string[];
  payload: GmailMessagePart;
}

/**
 * A thread's message list as needed to sort newest-first and cap the count
 * **before** fetching any body — `internalDate` (epoch milliseconds, as a
 * string, per Gmail's own wire format) is present regardless of the
 * per-message body content, so this stays cheap to sort on.
 */
export interface GmailThreadMessageRef {
  id: string;
  internalDate: string;
}

export interface GmailThread {
  id: string;
  messages: GmailThreadMessageRef[];
}

/**
 * `users.messages.modify`'s request body — backs `gmail_archive` (`removeLabelIds: ["INBOX"]`) and `gmail_label` (`addLabelIds`/`removeLabelIds: [resolvedLabelId]`). Both fields optional per Google's own API, though every call this codebase makes populates exactly one.
 */
export interface GmailModifyMessageRequest {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

/** One entry of `users.labels.list` — backs `gmail_label`'s name→id resolution. */
export interface GmailLabel {
  id: string;
  name: string;
}

export interface GmailClient {
  /** `GET /messages?q=...&labelIds=...&maxResults=...` — backs `gmail_list_unread`. Returns `messages: []` (never `undefined`) when the API response omits the field, e.g. an empty inbox. */
  listMessages(
    accessToken: string,
    query: GmailListMessagesQuery,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<GmailListMessagesResult>;
  /**
   * `GET /messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=To
   * &metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`
   * — headers and label ids only, no body, so this phase ships zero MIME
   * parsing code. Backs `gmail_list_unread`.
   */
  getMessageMetadata(
    accessToken: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMessageMetadata>;
  /**
   * `GET /messages/{id}?format=full` — full MIME structure (`payload`,
   * recursively, with each part's own `body.data`) for one message. Backs
   * `gmail_read_thread`'s per-message body extraction, called only for the
   * messages the per-thread cap actually keeps (Dependencies & Risks:
   * `gmail_read_thread` fans out over several `messages.get` calls, capped
   * *before* issuing them, not after).
   */
  getMessageFull(accessToken: string, id: string, signal?: AbortSignal): Promise<GmailMessageFull>;
  /**
   * `GET /threads/{id}?format=full` — backs `gmail_read_thread`. Only
   * `id`/`internalDate` are read off each returned message (enough to sort
   * newest-first and cap the count); the per-message body is fetched
   * separately, only for the capped subset, via `getMessageFull`.
   */
  getThread(accessToken: string, threadId: string, signal?: AbortSignal): Promise<GmailThread>;
  /**
   * `POST /messages/{id}/modify` — adds/removes labels on one message. Backs
   * `gmail_archive` (removing `INBOX`) and `gmail_label` (adding/removing a
   * resolved label id). Idempotent by Gmail's own semantics — adding an
   * already-present label or removing an already-absent one is a harmless
   * no-op — so it retries under the same rules `requestWithRetry` gives every
   * read (Phase 3 file-changes row).
   */
  modifyMessage(
    accessToken: string,
    id: string,
    request: GmailModifyMessageRequest,
    signal?: AbortSignal,
  ): Promise<void>;
  /** `GET /labels` — backs `gmail_label`'s label-name-to-id resolution, so `prepare` can refuse an unknown label legibly before any approval prompt. */
  listLabels(accessToken: string, signal?: AbortSignal): Promise<GmailLabel[]>;
}

export interface CreateGmailClientOptions {
  fetchImpl?: typeof fetch;
}

interface RawMessageListResponse {
  messages?: GmailMessageRef[];
  resultSizeEstimate?: number;
}

interface RawMessageHeader {
  name?: string;
  value?: string;
}

interface RawMessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: { headers?: RawMessageHeader[] };
}

interface RawMessageFullResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: GmailMessagePart;
}

interface RawThreadMessage {
  id: string;
  internalDate?: string;
}

interface RawThreadResponse {
  id: string;
  messages?: RawThreadMessage[];
}

interface RawLabelsListResponse {
  labels?: GmailLabel[];
}

function extractHeaders(rawHeaders: RawMessageHeader[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of rawHeaders ?? []) {
    if (header.name !== undefined && header.value !== undefined) {
      headers[header.name] = header.value;
    }
  }
  return headers;
}

/** Thin `fetch`-based client over the Gmail v1 REST API — no `googleapis`, no new third-party HTTP client (settled decision 20, same posture as `sheets-client.ts`/`calendar-client.ts`). */
export function createGmailClient(opts: CreateGmailClientOptions = {}): GmailClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async listMessages(accessToken, query, maxResults, signal) {
      const params = new URLSearchParams();
      if (query.q !== undefined && query.q !== "") params.set("q", query.q);
      for (const labelId of query.labelIds ?? []) params.append("labelIds", labelId);
      params.set("maxResults", String(maxResults));

      const url = `${GMAIL_API_BASE}/messages?${params.toString()}`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawMessageListResponse;
      return { messages: result.messages ?? [], resultSizeEstimate: result.resultSizeEstimate };
    },
    async getMessageMetadata(accessToken, id, signal) {
      const params = new URLSearchParams();
      params.set("format", "metadata");
      for (const header of METADATA_HEADERS) params.append("metadataHeaders", header);

      const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}?${params.toString()}`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawMessageResponse;
      return {
        id: result.id,
        threadId: result.threadId,
        labelIds: result.labelIds ?? [],
        headers: extractHeaders(result.payload?.headers),
        snippet: result.snippet ?? "",
      };
    },
    async getMessageFull(accessToken, id, signal) {
      const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}?format=full`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawMessageFullResponse;
      return {
        id: result.id,
        threadId: result.threadId,
        labelIds: result.labelIds ?? [],
        payload: result.payload ?? {},
      };
    },
    async getThread(accessToken, threadId, signal) {
      const url = `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=full`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawThreadResponse;
      return {
        id: result.id,
        messages: (result.messages ?? []).map((message) => ({
          id: message.id,
          internalDate: message.internalDate ?? "0",
        })),
      };
    },
    async modifyMessage(accessToken, id, request, signal) {
      const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}/modify`;
      await requestWithRetry(fetchImpl, url, accessToken, signal, request);
    },
    async listLabels(accessToken, signal) {
      const url = `${GMAIL_API_BASE}/labels`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawLabelsListResponse;
      return (result.labels ?? []).map((label) => ({ id: label.id, name: label.name }));
    },
  };
}
