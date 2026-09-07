# @hermes/google-calendar

The generic Google Calendar capability: read and manage events on the user's
own primary calendar. See `plans/08-calendar.md`'s Context for the full
design. Phase 1 shipped the package scaffold — REST client, timezone
resolution, deterministic relative-time resolution, window bounds, and the
event idempotency id — with nothing wired into the bot yet. Phase 2 wires
`/connect google calendar` and ships `list_events`, the first of the six
tools (`find_free_slot`, `check_availability`, `create_event`,
`reschedule_event`, `cancel_event` follow in later phases).

## Tools

- **`list_events`** (`tools/calendar-list-events.ts`) — ungated read, no
  `prepare`; the scope gate alone protects it
  (`apps/hermes/src/agent/with-required-scopes.ts`, gated on
  `CALENDAR_SCOPES`). Lists events on the user's primary calendar within a
  resolved time window: explicit `startIso`/`endIso` win outright; otherwise
  `relativeDay`/`weekday`/`timeOfDay` resolve one via `resolveRelativeWindow`,
  defaulting to `{ relativeDay: "today" }` when none of the three are given.
  The resolved window always passes through `validateTimeWindow` before any
  Calendar API call. `maxResults` (default 20, max 50) is passed straight to
  the API's own `maxResults` param — a single bounded request, no
  client-side pagination. Each returned event's `description` is truncated
  to 500 chars with a trailing `"… (truncado)"` marker if longer. Every
  event's time fields are rendered via `render-event-time.ts`'s
  `renderEventTime` — all-day events render a plain date, never crash
  attempting to parse a missing `dateTime`. `id` is always present on a
  returned event — it's the only handle a later `reschedule_event`/
  `cancel_event` call has for "which event."

## `render-event-time.ts`

`renderEventTime(event, timeZone)` — pure function branching on
`start.date` (all-day) vs `start.dateTime` (timed). A timed event renders
both the raw UTC ISO (`startUtc`/`endUtc`) and a human, local-offset-ISO
`localLabel` in the user's own timezone; an all-day event renders `localLabel`
as the plain `date` Google returned, with `allDay: true` and no timezone
math attempted. Shared by `list_events` here and `check_availability`'s
conflict display (Phase 3).

## Ports

One consumer-declared port, following `@hermes/google-sheets`'
`AccessTokenPort` convention — this package never imports `@hermes/store` or
`@hermes/google-auth` directly:

- `AccessTokenPort { getAccessToken(channel, channelUserId): Promise<string> }`
  (`access-token-port.ts`) — bound (Phase 2) in `apps/hermes/src/google/
  build-calendar-access-token-port.ts` over `@hermes/google-auth`'s
  `RefreshCoordinator.getValidAccessToken`, the same single refresh seam
  `google-sheets` already uses.

**v1 scope: the user's primary calendar only** (settled decision 5) — no
multi-calendar registry/slug port analogous to `SheetRegistryPort`.

## `calendar-client.ts`

A thin `fetch`-based client over the Calendar v3 REST API, built on
`@hermes/core`'s `withHttpRetry` — no `googleapis`, no new third-party HTTP
client (same posture as `sheets-client.ts`, settled decision 20). Seven
methods:

- `getPrimaryCalendarTimeZone(accessToken, signal?)` — `GET
  /calendars/primary`; backs `resolveUserTimeZone`'s cache-miss path.
- `listEvents(accessToken, { timeMinIso, timeMaxIso, maxResults }, signal?)`
  — `GET /calendars/primary/events?timeMin=...&timeMax=...&maxResults=...
  &singleEvents=true&orderBy=startTime`. `maxResults` is passed straight
  through to the API's own param — a single bounded request, no
  client-side pagination.
- `getEvent(accessToken, eventId, signal?)` — `GET
  /calendars/primary/events/{eventId}`.
- `queryFreeBusy(accessToken, { timeMinIso, timeMaxIso }, signal?)` — `POST
  /freeBusy` against the primary calendar.
- `insertEvent(accessToken, { id?, summary, description?, start, end },
  signal?)` — `POST /calendars/primary/events`, accepting a caller-supplied
  `id`.
- `patchEvent(accessToken, eventId, { start?, end? }, signal?)` — `PATCH
  /calendars/primary/events/{eventId}`.
- `deleteEvent(accessToken, eventId, signal?)` — `DELETE
  /calendars/primary/events/{eventId}`.

`insertEvent`/`patchEvent` take a fixed, whitelisted TS parameter type, never
a passthrough object — a stray `recurrence`/`attendees` field has no path to
reach the Calendar API. `CalendarApiError extends Error` (`status`,
`retryAfter`), the same shape as `SheetsApiError`.

**No ambiguous-write split, unlike `sheets-client.ts`.** Every request this
client makes is idempotent by construction: `GET`s naturally, `insertEvent`
via the caller-supplied `id` (a repeat insert 409s and is treated as
already-created by the tool layer), and `patchEvent`/`deleteEvent` because
both target an explicit event id with absolute values, so a resend converges
to the same end state. All seven methods therefore share one retry policy
(429 → rate-limited, honoring `Retry-After`; 5xx → transient; anything else
fatal) rather than `sheets-client.ts`'s read/write divergence. See
`.ai/decisions/calendar-event-idempotency.md`.

## `timezone-cache.ts`

`resolveUserTimeZone(deps, channel, channelUserId, signal?)` — the timezone
source of truth (settled decision 1) is the user's primary Google Calendar's
own `timeZone` field, never a "set your timezone" command. Cached in-process
(a module-level `Map<string, {timeZone, expiresAt}>` keyed by
`${channel}:${channelUserId}`) for `TIMEZONE_CACHE_TTL_MS` (6h) — calendar
timezone changes are rare. On a miss or expiry, fetches an access token and
calls `getPrimaryCalendarTimeZone`, then caches. `deps.clock` (a
`@hermes/core` `Clock`) defaults to `systemClock`; tests override it for
deterministic TTL expiry.

## `relative-time.ts`

Pure functions, no I/O, built on `luxon`'s `DateTime.fromISO(...,
{ zone: timeZone })` for IANA-timezone/DST-correct math (settled decision
2 — the model extracts a small structured `RelativeTimeIntent`
(`relativeDay`/`weekday`/`timeOfDay`); resolution to a concrete instant/range
is deterministic and tool-side, never left to the model). See
`.ai/decisions/luxon-timezone-library.md`.

- `resolveRelativeInstant(intent, nowUtcIso, timeZone)` — a UTC ISO instant,
  defaulting to a sensible local hour per `timeOfDay` (morning 09:00,
  afternoon 14:00, evening 18:00, night 21:00; defaults to morning when
  `timeOfDay` is omitted).
- `resolveRelativeWindow(intent, nowUtcIso, timeZone)` — a
  `{ startUtc, endUtc }` window: `weekday` (with or without `relativeDay`)
  narrows to that one calendar day; `relativeDay: "this_week"`/`"next_week"`
  without a `weekday` spans the whole ISO week (Monday-Sunday); every other
  case narrows to a single day. `timeOfDay` further narrows a single-day
  window to that time of day's hour range (morning 06:00-12:00, afternoon
  12:00-18:00, evening 18:00-21:00, night 21:00-24:00); it is not applied to
  a week-long window.

## `window-bounds.ts`

`validateTimeWindow(startUtc, endUtc, opts?)` — a pure guard against a
malformed relative-time resolution (an inverted range, or a multi-year span
from a bad intent) ever reaching Google. Rejects `startUtc >= endUtc` as
`"inverted_window"` and a window wider than `opts.maxDays` (default 31) as
`"window_too_large"`. Called by every tool that resolves or accepts a window
(`list_events`, `find_free_slot`, `check_availability`, Phases 2-3) before
any Calendar API call, whether the window came from `resolveRelativeWindow`
or explicit `startIso`/`endIso` args.

## `deterministic-event-id.ts`

`deriveEventId(turnId, canonicalArgs)` — `create_event`'s idempotency id
(settled decision 6, corrected; see
`.ai/decisions/calendar-event-idempotency.md`). Delegates canonicalization
and hashing to `@hermes/core`'s `sha256HexOfCanonicalJson` — no bespoke
encoding logic. Same `(turnId, canonicalArgs)` within the same turn yields
the same id; a different turn or different args yields a different one. A
SHA-256 hex digest is already a valid base32hex string and well within
Calendar's `id` field's 5-1024 length bound.

## Dependencies

`@hermes/core`, `zod`, `luxon` — no `googleapis`, no new third-party HTTP
client (settled decision 20). `luxon` is adopted specifically for
IANA-timezone/DST-correct date math; see
`.ai/decisions/luxon-timezone-library.md`. Deliberately not `@hermes/store`
or `@hermes/google-auth` — the port above is injected.
