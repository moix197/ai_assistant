import { type RetryClassConfig, withHttpRetry } from "@hermes/core";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Per-request timeout for one Calendar API attempt — independent of, and
 * smaller than, the calling tool's own `ToolSpec.timeoutMs`, which bounds
 * the *whole* handler call including this client's own retries. Mirrors
 * `sheets-client.ts`'s `REQUEST_TIMEOUT_MS`.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_TRANSIENT_RETRIES = 5;

const REDACTED_TOKEN = "<REDACTED>";

function redact(value: string, accessToken: string): string {
  return value.split(accessToken).join(REDACTED_TOKEN);
}

/** Thrown for any non-ok Calendar API response. `status`/`retryAfter` (seconds, when Google sends the header) drive `classify`'s retry decision below — same shape as `SheetsApiError`. */
export class CalendarApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null || headerValue.trim() === "") return undefined;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

type CalendarRetryClass = "rateLimit" | "transient";

/**
 * A 429 means Google rejected the request before applying it — safe to
 * retry, honoring the server-supplied `Retry-After` when present. Any 5xx
 * (necessarily *after* the request was sent) is "transient" and also safe to
 * retry freely: every request this client makes is idempotent by
 * construction — `GET`s naturally, `insertEvent` via the caller-supplied
 * `id` (a repeat insert 409s and is treated as already-created), and
 * `patchEvent`/`deleteEvent` because both operate on an explicit event id
 * with absolute target values, so a resend converges to the same end state.
 * There is therefore no `sheets-client.ts`-style ambiguous-write split here
 * (see `.ai/decisions/calendar-event-idempotency.md`). Any other status
 * (including 404/409, which callers must branch on) is fatal — thrown
 * directly, never returned, per `@hermes/core`'s `withHttpRetry` contract.
 */
function classify(error: unknown): { class: CalendarRetryClass; retryAfterMs?: number } {
  if (error instanceof CalendarApiError) {
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
  method?: "POST" | "PATCH" | "DELETE";
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
    const cause = error instanceof Error ? error.cause : undefined;
    const wrapped = new Error(redact(`Calendar request failed: ${message}`, accessToken), {
      cause,
    });
    if (error instanceof Error && error.name === "AbortError") wrapped.name = "AbortError";
    throw wrapped;
  }

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    throw new CalendarApiError(
      redact(`Calendar API returned HTTP ${response.status}: ${rawText}`, accessToken),
      response.status,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  // `deleteEvent` (and a 204 from any other method) returns no body — Calendar
  // API's usual success shape otherwise has one.
  if (response.status === 204) return undefined;
  const rawText = await response.text();
  if (rawText.trim() === "") return undefined;
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error("Calendar API response body is not valid JSON");
  }
}

/**
 * Every Calendar API call this client makes goes through the same
 * `withHttpRetry` policy — unlike `sheets-client.ts`'s read/write split,
 * there is no ambiguous-write class here because every call is idempotent
 * by construction (see `classify`'s doc comment).
 */
async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  externalSignal: AbortSignal | undefined,
  init?: RequestInitOverride,
): Promise<unknown> {
  const rateLimitConfig: RetryClassConfig = { maxAttempts: MAX_RATE_LIMIT_RETRIES };
  const transientConfig: RetryClassConfig = { maxAttempts: MAX_TRANSIENT_RETRIES };
  return withHttpRetry<unknown, CalendarRetryClass>({
    attempt: (signal) => requestJson(fetchImpl, url, accessToken, signal, init),
    timeoutMs: REQUEST_TIMEOUT_MS,
    externalSignal,
    classes: {
      rateLimit: rateLimitConfig,
      transient: transientConfig,
    },
    classify,
  });
}

export interface CalendarEventDateTime {
  /** Present for an all-day event; mutually exclusive with `dateTime`. */
  date?: string;
  /** Present for a timed event; an offset/UTC ISO instant. */
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
}

interface CalendarEventsListApiResponse {
  items?: CalendarEvent[];
}

export interface ListEventsParams {
  /** UTC ISO instant — inclusive lower bound. */
  timeMinIso: string;
  /** UTC ISO instant — exclusive upper bound. */
  timeMaxIso: string;
  /** Passed straight through to the API's own `maxResults` — a single bounded request, no client-side pagination. */
  maxResults: number;
}

export interface QueryFreeBusyParams {
  timeMinIso: string;
  timeMaxIso: string;
}

export interface FreeBusyInterval {
  start: string;
  end: string;
}

interface FreeBusyApiResponse {
  calendars?: Record<string, { busy?: FreeBusyInterval[] }>;
}

/** Fixed, whitelisted parameter type — never a passthrough object (see the recurring-events structural-scoping note in the plan's Context). */
export interface InsertEventParams {
  /** Client-supplied idempotency id (settled decision 6, corrected — see `.ai/decisions/calendar-event-idempotency.md`). */
  id?: string;
  summary: string;
  description?: string;
  /** UTC ISO instant. */
  start: string;
  /** UTC ISO instant. */
  end: string;
}

/** Fixed, whitelisted parameter type — only the two fields `reschedule_event` ever changes. */
export interface PatchEventParams {
  /** UTC ISO instant. */
  start?: string;
  /** UTC ISO instant. */
  end?: string;
}

interface CalendarResourceApiResponse {
  timeZone?: string;
}

export interface CalendarClient {
  /** `GET /calendars/primary` — backs `resolveUserTimeZone`'s cache miss path. */
  getPrimaryCalendarTimeZone(accessToken: string, signal?: AbortSignal): Promise<string>;
  /**
   * `GET /calendars/primary/events?timeMin=...&timeMax=...&maxResults=...
   * &singleEvents=true&orderBy=startTime` — backs `list_events` (Phase 2).
   */
  listEvents(
    accessToken: string,
    params: ListEventsParams,
    signal?: AbortSignal,
  ): Promise<CalendarEvent[]>;
  /** `GET /calendars/primary/events/{eventId}` — backs the `reschedule_event`/`cancel_event` pre-read and `create_event`'s 409-idempotent-retry path. */
  getEvent(accessToken: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent>;
  /** `POST /freeBusy` for the primary calendar — backs `find_free_slot`/`check_availability` (Phase 3). */
  queryFreeBusy(
    accessToken: string,
    params: QueryFreeBusyParams,
    signal?: AbortSignal,
  ): Promise<FreeBusyInterval[]>;
  /**
   * `POST /calendars/primary/events` — backs `create_event` (Phase 4). Uses
   * the same freely-retried policy as reads: the caller-supplied `id` plus
   * "409 means already created" makes a retried insert safe by construction
   * (settled decision 6, corrected; see
   * `.ai/decisions/calendar-event-idempotency.md`), unlike
   * `sheets-client.ts`'s `appendValues`.
   */
  insertEvent(
    accessToken: string,
    event: InsertEventParams,
    signal?: AbortSignal,
  ): Promise<CalendarEvent>;
  /** `PATCH /calendars/primary/events/{eventId}` — backs `reschedule_event` (Phase 5). */
  patchEvent(
    accessToken: string,
    eventId: string,
    patch: PatchEventParams,
    signal?: AbortSignal,
  ): Promise<CalendarEvent>;
  /** `DELETE /calendars/primary/events/{eventId}` — backs `cancel_event` (Phase 6). */
  deleteEvent(accessToken: string, eventId: string, signal?: AbortSignal): Promise<void>;
}

export interface CreateCalendarClientOptions {
  fetchImpl?: typeof fetch;
}

function eventDateTimeBody(iso: string): { dateTime: string } {
  return { dateTime: iso };
}

/** Thin `fetch`-based client over the Calendar v3 REST API — no `googleapis`, no new third-party HTTP client (same posture as `sheets-client.ts`, settled decision 20). */
export function createCalendarClient(opts: CreateCalendarClientOptions = {}): CalendarClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async getPrimaryCalendarTimeZone(accessToken, signal) {
      const url = `${CALENDAR_API_BASE}/calendars/primary`;
      const response = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as CalendarResourceApiResponse;
      return response.timeZone ?? "UTC";
    },
    async listEvents(accessToken, params, signal) {
      const query = new URLSearchParams({
        timeMin: params.timeMinIso,
        timeMax: params.timeMaxIso,
        maxResults: String(params.maxResults),
        singleEvents: "true",
        orderBy: "startTime",
      });
      const url = `${CALENDAR_API_BASE}/calendars/primary/events?${query.toString()}`;
      const response = (await requestWithRetry(
        fetchImpl,
        url,
        accessToken,
        signal,
      )) as CalendarEventsListApiResponse;
      return response.items ?? [];
    },
    async getEvent(accessToken, eventId, signal) {
      const url = `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      return (await requestWithRetry(fetchImpl, url, accessToken, signal)) as CalendarEvent;
    },
    async queryFreeBusy(accessToken, params, signal) {
      const url = `${CALENDAR_API_BASE}/freeBusy`;
      const response = (await requestWithRetry(fetchImpl, url, accessToken, signal, {
        method: "POST",
        body: {
          timeMin: params.timeMinIso,
          timeMax: params.timeMaxIso,
          items: [{ id: "primary" }],
        },
      })) as FreeBusyApiResponse;
      return response.calendars?.primary?.busy ?? [];
    },
    async insertEvent(accessToken, event, signal) {
      const url = `${CALENDAR_API_BASE}/calendars/primary/events`;
      const body = {
        ...(event.id !== undefined ? { id: event.id } : {}),
        summary: event.summary,
        ...(event.description !== undefined ? { description: event.description } : {}),
        start: eventDateTimeBody(event.start),
        end: eventDateTimeBody(event.end),
      };
      return (await requestWithRetry(fetchImpl, url, accessToken, signal, {
        method: "POST",
        body,
      })) as CalendarEvent;
    },
    async patchEvent(accessToken, eventId, patch, signal) {
      const url = `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      const body = {
        ...(patch.start !== undefined ? { start: eventDateTimeBody(patch.start) } : {}),
        ...(patch.end !== undefined ? { end: eventDateTimeBody(patch.end) } : {}),
      };
      return (await requestWithRetry(fetchImpl, url, accessToken, signal, {
        method: "PATCH",
        body,
      })) as CalendarEvent;
    },
    async deleteEvent(accessToken, eventId, signal) {
      const url = `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`;
      await requestWithRetry(fetchImpl, url, accessToken, signal, { method: "DELETE" });
    },
  };
}
