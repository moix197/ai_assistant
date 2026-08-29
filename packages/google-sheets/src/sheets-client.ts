import { type RetryClassConfig, withHttpRetry } from "@hermes/core";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Per-request timeout for one Sheets API attempt — independent of, and
 * smaller than, the calling tool's own `ToolSpec.timeoutMs` (30s for both
 * `sheets_inspect`/`sheets_read`), which bounds the *whole* handler call
 * including this client's own retries.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Sheets' ~60 requests/min/user quota is the practical trigger — a real 429, not a hypothetical (settled decision 15). */
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_TRANSIENT_RETRIES = 5;

const REDACTED_TOKEN = "<REDACTED>";

function redact(value: string, accessToken: string): string {
  return value.split(accessToken).join(REDACTED_TOKEN);
}

/** Thrown for any non-ok Sheets API response. `status`/`retryAfter` (seconds, when Google sends the header) drive `classify`'s retry decision below — mirrors `packages/llm`'s `LlmHttpError`. */
export class SheetsApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "SheetsApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null || headerValue.trim() === "") return undefined;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

type SheetsRetryClass = "rateLimit" | "transient";

/**
 * A 429 means Google rejected the request before applying it — safe to
 * retry, and waits for the server-supplied `Retry-After` when present. Any
 * 5xx (necessarily *after* the request was sent) is "transient" — reads are
 * naturally idempotent (`GET`), so retrying one freely within the tool's own
 * timeout budget carries no risk (settled decision 15 — the ambiguous-write
 * distinction that same decision draws is a `sheets_write`/Phase 5 concern,
 * not applicable to this read-only client). Any other status is fatal —
 * thrown directly, never returned, per `@hermes/core`'s `withHttpRetry`
 * contract.
 */
function classify(error: unknown): { class: SheetsRetryClass; retryAfterMs?: number } {
  if (error instanceof SheetsApiError) {
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

interface RequestInitOverride {
  method?: "POST" | "PUT";
  body?: unknown;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  signal: AbortSignal,
  init?: RequestInitOverride,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init?.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserves the raw fetch failure's own `cause` (e.g. undici's
    // `{ code: "ECONNRESET" }` on a post-send socket failure) so
    // `classifyWrite` below can inspect it — a bare `TypeError: fetch
    // failed` collapses pre-send and post-send network failures into one
    // indistinguishable message, but `cause.code` (when present) does not.
    const cause = error instanceof Error ? error.cause : undefined;
    const wrapped = new Error(redact(`Sheets request failed: ${message}`, accessToken), {
      cause,
    });
    // Preserves "this was our own timeout abort" as a discriminable identity
    // (`classifyWrite` below keys off it) instead of collapsing every fetch
    // failure into one indistinguishable shape.
    if (error instanceof Error && error.name === "AbortError") wrapped.name = "AbortError";
    throw wrapped;
  }

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    throw new SheetsApiError(
      redact(`Sheets API returned HTTP ${response.status}: ${rawText}`, accessToken),
      response.status,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error("Sheets API response body is not valid JSON");
  }
}

/** Retries `requestJson` via `@hermes/core`'s shared `withHttpRetry` — the same mechanism `packages/llm`'s adapter and `packages/channels`' Telegram client use (`05-google-sheets` Phase 1). */
async function getWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  externalSignal: AbortSignal | undefined,
): Promise<unknown> {
  return withHttpRetry<unknown, SheetsRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal),
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
 * Thrown by `appendValues` when a post-send failure (timeout after send, or
 * a 5xx necessarily received after the request reached Google) leaves the
 * write's outcome genuinely unknown, and — unlike `updateValues` — is never
 * retried by this client: `POST :append` is not idempotent, so resending an
 * already-applied append would double the row (settled decision 15).
 * `sheets-write.ts` catches this specific type to surface the "may or may
 * not have landed, check the sheet" outcome to the model instead of a bare
 * fatal error.
 */
export class SheetsAmbiguousWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsAmbiguousWriteError";
  }
}

type WriteRetryClass = "rateLimit" | "preSendNetwork" | "postSendAmbiguous";

/**
 * Node/undici error codes that provably mean the request never left this
 * process — the connection itself could not be established. Anything else
 * (a reset, a premature close, "terminated", or no discoverable code at all)
 * happens on a connection that may already have carried the request to
 * Google, so it cannot be assumed pre-send.
 */
const PRE_SEND_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * `undici`/Node raise a post-send socket failure (a reset, a premature
 * close) as the same bare `TypeError: fetch failed` shape as a genuine
 * pre-send failure — the only place the two are actually distinguishable is
 * `error.cause.code`. A `cause` with no recognizable code, or no `cause` at
 * all, must NOT be assumed pre-send: fail-safe means treating "we can't tell"
 * as ambiguous, not as safe-to-retry.
 */
function isPreSendNetworkFailure(error: Error): boolean {
  const cause = error.cause;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && PRE_SEND_NETWORK_CODES.has(code);
}

/**
 * Same 429/5xx split `classify` (above) draws, but a fetch-level throw that
 * isn't this client's own timeout abort is classified `preSendNetwork` only
 * when `isPreSendNetworkFailure` can prove the request never left
 * (connection refused, DNS failure, ...); everything else — including a bare
 * `TypeError: fetch failed` with an unrecognized or absent `cause` — is
 * `postSendAmbiguous`. Per settled decision 15, only "the request definitely
 * reached Google and we don't know what happened next" is actually
 * ambiguous, but a socket failure *after* the request was sent (a reset, a
 * premature close) surfaces as the exact same undistinguishable
 * `TypeError: fetch failed` as one that never left — so anything not
 * provably pre-send must be treated as ambiguous, not retried, to avoid
 * resending an append that already landed.
 */
function classifyWrite(error: unknown): { class: WriteRetryClass; retryAfterMs?: number } {
  if (error instanceof SheetsApiError) {
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
 * Shared by `appendValues`/`updateValues` — the same `withHttpRetry`
 * mechanism `getWithRetry` uses, with a caller-supplied
 * `ambiguousRetryConfig` for the one class whose retry policy differs per
 * mode (settled decision 15): `appendValues` passes `{maxAttempts: 0}` (a
 * `buildExhaustedError` turning the very first ambiguous failure into a
 * `SheetsAmbiguousWriteError`, never retried); `updateValues` passes
 * `{maxAttempts: 1}` (no override — a second ambiguous failure just rethrows
 * the original error as a genuine fatal one), so the identical `attempt`
 * closure — same URL, method, and body — is what actually performs
 * `updateValues`'s "retry once with the identical range/values" safe retry,
 * not a second, separately-constructed call.
 */
async function sendWriteRequestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  method: "POST" | "PUT",
  body: unknown,
  externalSignal: AbortSignal | undefined,
  ambiguousRetryConfig: RetryClassConfig,
): Promise<unknown> {
  return withHttpRetry<unknown, WriteRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal, { method, body }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    externalSignal,
    classes: {
      rateLimit: { maxAttempts: MAX_RATE_LIMIT_RETRIES },
      preSendNetwork: { maxAttempts: MAX_TRANSIENT_RETRIES },
      postSendAmbiguous: ambiguousRetryConfig,
    },
    classify: classifyWrite,
  });
}

export interface SheetProperties {
  sheetId: number;
  title: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

export interface SheetCellValue {
  formattedValue?: string;
}

export interface SheetMeta {
  sheets: Array<{
    properties: SheetProperties;
    data?: Array<{ rowData?: Array<{ values?: SheetCellValue[] }> }>;
  }>;
}

export interface SheetsValuesResult {
  range: string;
  majorDimension?: string;
  values?: unknown[][];
}

export type ValueRenderOption = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";

export type ValueInputOption = "RAW" | "USER_ENTERED";

/** Normalized shape both `appendValues` (unwrapped from the API's nested `updates` object) and `updateValues` (the API's own top-level shape) resolve to — one consistent result for `sheets-write.ts` to relay regardless of mode. */
export interface SheetsWriteResult {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

interface SheetsAppendApiResponse {
  updates?: SheetsWriteResult;
}

export interface SheetsClient {
  /**
   * Two Sheets API calls, not one: `GET .../spreadsheets/{id}
   * ?fields=sheets.properties` first, to learn each tab's title with no cell
   * data at all, then `GET .../spreadsheets/{id}?fields=sheets.properties,
   * sheets.data.rowData.values.formattedValue&ranges=<title>!1:1` (one
   * `ranges` entry per tab) to fetch just its header row. Google's `ranges`
   * param only bounds the spreadsheet's *first* sheet when left unqualified
   * — bounding every tab's cell data to its own header row, not the
   * unbounded default response (a large spreadsheet's every row of every
   * tab), needs each tab's title known first. Backs `sheets_inspect`, which
   * only needs tab names, dimensions, and header rows — never full cell
   * data.
   */
  getSpreadsheetMeta(
    accessToken: string,
    spreadsheetId: string,
    signal?: AbortSignal,
  ): Promise<SheetMeta>;
  /**
   * `GET /v4/spreadsheets/{spreadsheetId}/values/{range}?valueRenderOption=...`
   * — backs `sheets_read`.
   */
  getValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    valueRenderOption: ValueRenderOption,
    signal?: AbortSignal,
  ): Promise<SheetsValuesResult>;
  /**
   * `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append
   * ?valueInputOption=...&insertDataOption=...` — backs `sheets_write`'s
   * `mode: "append"`. `insertDataOption` defaults to `INSERT_ROWS`, the
   * shape that actually inserts new rows rather than overwriting whatever
   * already occupies the next empty rows inside `range`. Not idempotent: a
   * resend of an already-applied append doubles the row, so a post-send
   * ambiguous failure here throws `SheetsAmbiguousWriteError` rather than
   * retrying (settled decision 15).
   */
  appendValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption,
    insertDataOption?: "INSERT_ROWS" | "OVERWRITE",
    signal?: AbortSignal,
  ): Promise<SheetsWriteResult>;
  /**
   * `PUT /v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=...`
   * — backs `sheets_write`'s `mode: "update"`. A fixed-range `PUT` converges
   * to the same end state regardless of whether a prior attempt landed, so a
   * post-send ambiguous failure here is retried once, internally, with the
   * identical `range`/`values` — invisible to the caller as an ambiguity at
   * all (settled decision 15).
   */
  updateValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption: ValueInputOption,
    signal?: AbortSignal,
  ): Promise<SheetsWriteResult>;
}

export interface CreateSheetsClientOptions {
  fetchImpl?: typeof fetch;
}

/**
 * A1-notation sheet-name quoting: a title containing anything but letters,
 * digits, or underscores must be single-quoted, with any embedded single
 * quote doubled — the same rule Sheets applies to its own A1 ranges. Most
 * real spreadsheet tab names have spaces, so this is the common case, not
 * an edge case.
 */
function quoteSheetTitle(title: string): string {
  return /^[A-Za-z_]\w*$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

/** Thin `fetch`-based client over the Sheets v4 REST API — no `googleapis`, no new third-party HTTP client (settled decision 20). */
export function createSheetsClient(opts: CreateSheetsClientOptions = {}): SheetsClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async getSpreadsheetMeta(accessToken, spreadsheetId, signal) {
      const propertiesFields = "sheets.properties";
      const propertiesUrl = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(propertiesFields)}`;
      const propertiesOnly = (await getWithRetry(
        fetchImpl,
        propertiesUrl,
        accessToken,
        signal,
      )) as SheetMeta;

      const titles = (propertiesOnly.sheets ?? []).map((sheet) => sheet.properties.title);
      if (titles.length === 0) return propertiesOnly;

      const fields = "sheets.properties,sheets.data.rowData.values.formattedValue";
      const rangesQuery = titles
        .map((title) => `ranges=${encodeURIComponent(`${quoteSheetTitle(title)}!1:1`)}`)
        .join("&");
      const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}&${rangesQuery}`;
      return (await getWithRetry(fetchImpl, url, accessToken, signal)) as SheetMeta;
    },
    async getValues(accessToken, spreadsheetId, range, valueRenderOption, signal) {
      const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=${encodeURIComponent(valueRenderOption)}`;
      return (await getWithRetry(fetchImpl, url, accessToken, signal)) as SheetsValuesResult;
    },
    async appendValues(
      accessToken,
      spreadsheetId,
      range,
      values,
      valueInputOption,
      insertDataOption,
      signal,
    ) {
      const resolvedInsertDataOption = insertDataOption ?? "INSERT_ROWS";
      const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=${encodeURIComponent(valueInputOption)}&insertDataOption=${encodeURIComponent(resolvedInsertDataOption)}`;
      const response = (await sendWriteRequestWithRetry(
        fetchImpl,
        url,
        accessToken,
        "POST",
        { values },
        signal,
        {
          maxAttempts: 0,
          buildExhaustedError: () =>
            new SheetsAmbiguousWriteError(
              "Sheets append may or may not have landed: the request timed out or Google returned a server error after it was sent, and a resend is not safe (it could double-append the row) — check the sheet before retrying.",
            ),
        },
      )) as SheetsAppendApiResponse;
      return response.updates ?? {};
    },
    async updateValues(accessToken, spreadsheetId, range, values, valueInputOption, signal) {
      const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}`;
      return (await sendWriteRequestWithRetry(
        fetchImpl,
        url,
        accessToken,
        "PUT",
        { values },
        signal,
        // A fixed-range PUT converges to the same end state regardless of
        // whether the first attempt landed, so one internal retry with the
        // identical range/values (the same `attempt` closure, not a new
        // call) safely resolves the ambiguity rather than surfacing it.
        { maxAttempts: 1 },
      )) as SheetsWriteResult;
    },
  };
}
