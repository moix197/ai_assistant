import { withHttpRetry } from "@hermes/core";

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

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`Sheets request failed: ${message}`, accessToken));
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
  return /^\w+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
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

      const titles = propertiesOnly.sheets.map((sheet) => sheet.properties.title);
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
  };
}
