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
  method?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
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
 * clients use. Shared by every `GET`, `POST` and `PUT` call this client
 * makes: a `GET` is naturally idempotent; the `POST`s (`modifyMessage`,
 * `users.messages.modify`; `createDraft`, `users.drafts.create`) and the one
 * `PUT` (`updateDraft`, `users.drafts.update`) are all idempotent by Gmail's
 * own semantics too — adding an already-present label or removing an
 * already-absent one is a no-op, creating/replacing a draft's content has no
 * partial-application hazard — so all three retry under the same rules with
 * no special-casing by method. `method` defaults from `body`'s presence
 * (`POST`/`GET`) when omitted, so every pre-existing call site is unaffected;
 * `updateDraft` is the one caller that passes `"PUT"` explicitly.
 */
async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  externalSignal: AbortSignal | undefined,
  body?: unknown,
  method?: string,
): Promise<unknown> {
  return withHttpRetry<unknown, GmailRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal, body, method),
    timeoutMs: REQUEST_TIMEOUT_MS,
    externalSignal,
    classes: {
      rateLimit: { maxAttempts: MAX_RATE_LIMIT_RETRIES },
      transient: { maxAttempts: MAX_TRANSIENT_RETRIES },
    },
    classify,
  });
}

/**
 * Thrown by `sendDraft` when a post-send failure (timeout after send, or a
 * 5xx necessarily received after the request reached Google) leaves the
 * send's outcome genuinely unknown, and — like `sheets-client.ts`'s
 * `SheetsAmbiguousWriteError` for `appendValues` — is never retried by this
 * client: `POST :send` is not idempotent, and the recovery for a false "it
 * failed" is a duplicate email to a real human. `gmail-send-draft.ts` catches
 * this specific type to surface the "may or may not have landed, check Sent"
 * hedge instead of a bare fatal error, and to know **not** to release the
 * pending `gmail_send_log` claim.
 */
export class GmailAmbiguousSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAmbiguousSendError";
  }
}

type GmailSendRetryClass = "rateLimit" | "preSendNetwork" | "postSendAmbiguous";

/**
 * Node/undici error codes that provably mean the request never left this
 * process — the connection itself could not be established. Anything else
 * (a reset, a premature close, "terminated", or no discoverable code at all)
 * happens on a connection that may already have carried the request to
 * Google, so it cannot be assumed pre-send. Mirrors
 * `sheets-client.ts`'s identically-named constant/function pair exactly.
 */
const PRE_SEND_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function isPreSendNetworkFailure(error: Error): boolean {
  const cause = error.cause;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && PRE_SEND_NETWORK_CODES.has(code);
}

/**
 * The same 429/5xx split `classify` (above) draws, but a fetch-level throw
 * that isn't this client's own timeout abort is classified `preSendNetwork`
 * only when `isPreSendNetworkFailure` can prove the request never left
 * (connection refused, DNS failure, ...); everything else — including a bare
 * `TypeError: fetch failed` with an unrecognized or absent `cause` — is
 * `postSendAmbiguous`. A send that definitely reached Google and was
 * rejected outright (a non-429 4xx) or exhausted its 429 retries (never got
 * past quota enforcement) is thrown directly, never returned — the
 * definitive branch `gmail-send-draft.ts`'s handler releases its pending
 * claim for. Mirrors `sheets-client.ts`'s `classifyWrite` exactly.
 */
function classifySend(error: unknown): { class: GmailSendRetryClass; retryAfterMs?: number } {
  if (error instanceof GmailApiError) {
    if (error.status === 429) {
      return {
        class: "rateLimit",
        retryAfterMs: error.retryAfter !== undefined ? error.retryAfter * 1000 : undefined,
      };
    }
    if (error.status >= 500) return { class: "postSendAmbiguous" };
    throw error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { class: "postSendAmbiguous" };
  }
  if (error instanceof Error && isPreSendNetworkFailure(error)) {
    return { class: "preSendNetwork" };
  }
  return { class: "postSendAmbiguous" };
}

/**
 * `POST /users/me/drafts/send` (`users.drafts.send`) — never retried on
 * `postSendAmbiguous` (`maxAttempts: 0`, mirroring `sheets-client.ts`'s
 * `appendValues`): a resend after a genuinely ambiguous failure risks
 * sending the mail twice, which is never an acceptable trade against "the
 * tool reports a hedge instead". `buildExhaustedError` turns the very first
 * ambiguous failure into a `GmailAmbiguousSendError`; a `rateLimit`/
 * `preSendNetwork` failure retries as usual, since Google rejected (or never
 * received) the request before ever applying it.
 */
async function sendDraftWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  draftId: string,
  externalSignal: AbortSignal | undefined,
): Promise<unknown> {
  return withHttpRetry<unknown, GmailSendRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal, { id: draftId }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    externalSignal,
    classes: {
      rateLimit: { maxAttempts: MAX_RATE_LIMIT_RETRIES },
      preSendNetwork: { maxAttempts: MAX_TRANSIENT_RETRIES },
      postSendAmbiguous: {
        maxAttempts: 0,
        buildExhaustedError: () =>
          new GmailAmbiguousSendError(
            "Gmail send may or may not have landed: the request timed out or Google returned a server error after it was sent, and a resend is not safe (it could send the mail twice) — check Sent before retrying.",
          ),
      },
    },
    classify: classifySend,
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

/** `users.drafts.create`/`.update`'s request body — the `raw` field is `build-mime-message.ts`'s `buildMimeMessage` output, composed once in `prepare` and threaded here verbatim. */
export interface GmailDraftRequest {
  threadId: string;
  raw: string;
}

/** One Gmail draft resource, as returned by `drafts.create`/`.update`/`.get` — backs `gmail_draft_reply` (Phase 4) and `gmail_send_draft` (Phase 5, `getDraft`'s existence check). */
export interface GmailDraft {
  id: string;
  message: { id: string; threadId: string };
}

/** The sent **message** `drafts.send` returns — `id` is the new sent message's id, never the draft's (the draft resource no longer exists once sent). */
export interface GmailSendResult {
  id: string;
  threadId: string;
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
  /**
   * `POST /drafts` (`users.drafts.create`) — creates a new draft carrying
   * `raw` (the full composed message) under `threadId`, so it lands
   * correctly threaded in Gmail's own UI. Backs `gmail_draft_reply`'s create
   * path (no `draftId` supplied).
   */
  createDraft(
    accessToken: string,
    request: GmailDraftRequest,
    signal?: AbortSignal,
  ): Promise<GmailDraft>;
  /**
   * `PUT /drafts/{draftId}` (`users.drafts.update`) — replaces an existing
   * draft's message wholesale with `raw`/`threadId`. Backs `gmail_draft_reply`'s
   * update path (a `draftId` supplied) — the same draft id in, the same draft
   * id out, never a second draft.
   */
  updateDraft(
    accessToken: string,
    draftId: string,
    request: GmailDraftRequest,
    signal?: AbortSignal,
  ): Promise<GmailDraft>;
  /** `GET /drafts/{draftId}` (`users.drafts.get`) — fetches one draft by id. Not called by `gmail_draft_reply`; exists for Phase 5's `gmail_send_draft` existence check before sending. */
  getDraft(accessToken: string, draftId: string, signal?: AbortSignal): Promise<GmailDraft>;
  /**
   * `POST /drafts/send` (`users.drafts.send`) — sends `draftId` as-is and
   * deletes the draft resource; Google returns the resulting **sent
   * message**, not the (now-gone) draft. Backs `gmail_send_draft`'s one
   * irreversible call. Never retried on a post-send-ambiguous failure — see
   * `classifySend`/`GmailAmbiguousSendError` above.
   */
  sendDraft(accessToken: string, draftId: string, signal?: AbortSignal): Promise<GmailSendResult>;
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

interface RawDraftResponse {
  id: string;
  message: { id: string; threadId: string };
}

interface RawSendResponse {
  id: string;
  threadId: string;
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
    async createDraft(accessToken, request, signal) {
      const url = `${GMAIL_API_BASE}/drafts`;
      const result = (await requestWithRetry(fetchImpl, url, accessToken, signal, {
        message: { threadId: request.threadId, raw: request.raw },
      })) as RawDraftResponse;
      return {
        id: result.id,
        message: { id: result.message.id, threadId: result.message.threadId },
      };
    },
    async updateDraft(accessToken, draftId, request, signal) {
      const url = `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
        { message: { threadId: request.threadId, raw: request.raw } },
        "PUT",
      )) as RawDraftResponse;
      return {
        id: result.id,
        message: { id: result.message.id, threadId: result.message.threadId },
      };
    },
    async getDraft(accessToken, draftId, signal) {
      const url = `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`;
      const result = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as RawDraftResponse;
      return {
        id: result.id,
        message: { id: result.message.id, threadId: result.message.threadId },
      };
    },
    async sendDraft(accessToken, draftId, signal) {
      const url = `${GMAIL_API_BASE}/drafts/send`;
      const result = (await sendDraftWithRetry(
        fetchImpl,
        url,
        accessToken,
        draftId,
        signal,
      )) as RawSendResponse;
      return { id: result.id, threadId: result.threadId };
    },
  };
}
