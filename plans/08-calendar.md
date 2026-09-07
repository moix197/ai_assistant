# Plan: Calendar (Roadmap Phase 5)

**Created:** 2026-09-06
**Branch:** `feat/08-calendar`
**Status:** not started

## Context

`04-google-auth` gave Hermes Google OAuth (encrypted, auto-refreshing tokens,
incremental scope consent). `05-google-sheets` proved the shape a Google tool
package takes in this codebase: a thin `fetch`-based REST client, an
`AccessTokenPort` declared by the consumer package (never imported from
`google-auth` directly), a scope gate (`withRequiredScopes`) that lives in
`apps/hermes`, and an approval-gate `prepare()` hook that resolves a
tool-agnostic `ApprovalSummary` before a human is ever asked. `06` then made
that summary legible and bounded every read.

This plan ships `plans/ROADMAP.md`'s **Phase 5 — Calendar**: a new
`@hermes/google-calendar` package with three ungated read tools
(`list_events`, `find_free_slot`, `check_availability`) and three
approval-gated write tools (`create_event`, `reschedule_event`,
`cancel_event`), plus deterministic relative-time resolution ("tomorrow after
2", "next Thursday morning") and correct timezone handling (events stored/
transferred as UTC, rendered in the user's own zone).

Roadmap exit criterion, verbatim: **"what's on tomorrow?" and "move my 3pm to
Thursday 10am" both work.** The first maps to `list_events` (Phase 2 below);
the second to `reschedule_event` (Phase 5), which needs the model to have
already seen an event's `id` from a prior `list_events` call in the same
conversation — no separate "find event by description" tool is built; the
agent chains two tool calls, same as it already chains reads before writes
against Sheets.

**Built in parallel with Phase 6 (Gmail).** Per `ROADMAP.md`: *"Both are
Google tool packages riding Phase 3's OAuth, and share only
`packages/google-auth/src/scopes.ts` and the tool registry."* Every edit this
plan makes to a file Gmail also touches (`scopes.ts`, `build-agent.ts`,
`with-required-scopes.ts`, `boot.ts`, `connect.ts`) is additive-only — a new
const, branch, map row, array entry, or trailing parameter, never a change to
an existing line. See Dependencies & Risks.

**Resolved design decisions** (settled by the user; implemented as stated,
not re-litigated below):

1. **Timezone source of truth** — derived from the user's primary Google
   Calendar's own `timeZone` field (`calendars.get('primary')`), cached
   in-process. No "set your timezone" command/UX.
2. **Relative-time resolution is deterministic and tool-side, not
   model-side.** The model extracts a small structured intent
   (`relativeDay`/`weekday`/`timeOfDay`); a dedicated resolver turns that
   plus "now" plus the user's zone into a concrete UTC instant/range. New
   dependency: **luxon**, for IANA-timezone/DST-correct date math — a
   written `.ai/decisions/` justification ships in Phase 1.
3. **`reschedule_event` and `cancel_event`'s `prepare()` hooks fetch the
   current event by id** (one bounded GET) before building the
   `ApprovalSummary`, so the prompt shows a real old→new time or "cancelling:
   \<title\> at \<time\>" — not a no-preread summary. `create_event` needs no
   pre-read (nothing exists yet); its `prepare()` only resolves the requested
   time and derives the idempotency id, no Google call.
4. **OAuth scope:** one broad `https://www.googleapis.com/auth/calendar` for
   all six tools — no per-operation scope split.
5. **v1 scope: the user's primary calendar only.** No multi-calendar
   registry/slug port analogous to `SheetRegistryPort`. Consequence: **no DB
   migration in this plan** — unlike Sheets, Calendar persists nothing new.
6. **`create_event` idempotency: a stable id derived deterministically from
   the turn/approval identity**, enforced by the Calendar API itself on
   insert — no separate claim-log table like `SheetWriteLogPort`.
7. **Gmail coordination contract:** all shared-file changes are additive
   only.

**One correction flagged, not re-litigated — implemented per the intent of
decision 6, using the mechanism Google actually supports:** Google Calendar's
`events.insert` does **not** enforce uniqueness on the `iCalUID` field (that
dedup behavior belongs to the separate `events.import` endpoint, which has
different, sync-oriented semantics). The mechanism Google documents for
idempotent-retry inserts is a **client-supplied event `id`**
(lowercase base32hex, 5–1024 chars): inserting twice with the same `id`
returns `409 Conflict` on the second call, which the tool treats as
"already created" and returns the existing event via a `GET` instead of
erroring. This satisfies decision 6's actual intent — a deterministic key
derived from the turn/approval identity, uniqueness enforced server-side, no
separate audit table — via `id`, not `iCalUID`.

**What this id actually protects against — corrected framing.** `ctx.turnId`
is generated once per inbound message (once per `runTurn`), not once per
approval-cycle, and Telegram's approval gate already deletes a pending
approval synchronously on first resolution (`telegram-approval-gate.ts`) — a
second tap on an already-resolved approval gets an "expired" reply and never
re-invokes `handler`. So the id's real value is **not** double-tap protection
(that path is already closed upstream). It protects against two things that
*are* still possible: (1) the model emitting two identical `create_event`
tool calls within the same turn (same hash, same id, second insert 409s and
is treated as already-created), and (2) `calendar-client.ts` safely
**retrying** an ambiguous insert failure (network drop, 5xx, 429) using the
same freely-retried `withHttpRetry` policy the read tools use — unlike
`sheets-client.ts`, which deliberately does *not* retry its own ambiguous
write failures (`SheetsAmbiguousWriteError`) because Sheets has no
idempotency key. Calendar's id-based `insert` can safely use the same retry
policy as a read precisely because retries are idempotent by construction.

Implemented in Phase 1 (`deterministic-event-id.ts`, which reuses
`packages/google-sheets/src/canonical-args.ts`'s `sortKeysDeep` +
canonical-JSON + SHA-256-hex pattern via a new additive `@hermes/core` export
— a SHA-256 hex digest is already valid base32hex (`0-9a-f` ⊂ `0-9a-v`), so no
new encoder is written) and used in Phase 4. Written up in
`.ai/decisions/calendar-event-idempotency.md`, created in **Phase 1**
alongside the mechanism it justifies — not deferred to closeout, since the
correction was already known before implementation started.

**Explicitly out of scope, owned by later work:**

- **Gmail** — its own PRD (Phase 6), coordinating only through the shared
  files named above.
- **Multi-calendar support / a `CalendarRegistryPort`** — decision 5.
- **A persisted write-log/dedupe table** — decision 6; the deterministic
  event `id` is the only idempotency mechanism.
- **Attendees, invites, recurring events, reminders/notifications, calendar
  sharing.** Only single, non-recurring events on the primary calendar:
  create, reschedule (time only), cancel. Enforced structurally, not just by
  prose: all six tool schemas are `.strict()` zod objects, and
  `calendar-client.ts`'s `insertEvent`/`patchEvent` take a fixed, whitelisted
  TS parameter type (never a passthrough object) — a stray `recurrence` or
  `attendees` field from a future schema change or model hallucination has no
  path to reach the Calendar API even before validation would strip it.
- **All-day events are never created or rescheduled** — writes always resolve
  a concrete `dateTime`, never a bare `date`. But `list_events` and
  `check_availability` must not crash on an *existing* all-day event Google
  returns (a holiday, a birthday) — see Phase 2's `render-event-time.ts`,
  which branches on `start.date` vs `start.dateTime` and renders all-day
  events without a timezone-converted clock time.
- **A generic cross-package bounded-read helper.**
  `.ai/decisions/bounded-tool-results.md` scoped `truncateBySize` to Sheets
  and explicitly rejected a generic loop-level cap ("the generic loop cannot
  measure 'cells'"). Calendar reads are already bounded at the request level
  (`maxResults`, a freebusy window) — see Phase 2/3 — so no dual-cap
  accumulator is ported over; a per-field description truncation is enough.
- **`trading-journal`** — deferred indefinitely
  (`.ai/decisions/defer-trading-journal.md`); nothing here depends on it.

## Risk: high

New sensitive OAuth scope, real DST/timezone-correctness surface, and three
tools that mutate a real external calendar with the approval gate as the only
safety net.

## Dependencies & Risks

- **New sensitive scope** (`.../auth/calendar`) — live Google consent screen
  required to verify Phase 2 onward; cannot be fully verified by automated
  tests alone (flagged per-phase below).
- **Timezone/DST correctness is genuinely hard.** luxon is adopted
  specifically so this isn't hand-rolled; `relative-time.ts`'s tests must
  include at least one DST-transition date in a real IANA zone (e.g.
  `America/New_York` around a spring-forward/fall-back boundary).
- **Shared-file coordination with parallel Gmail work.** Touched here, all
  additive-only: `packages/google-auth/src/scopes.ts` (new const, new
  `resolveConnectScopes` branch, new `TOOL_REQUIRED_SCOPES` rows),
  `apps/hermes/src/agent/build-agent.ts` (new tool constructions appended to
  the `tools` array; `buildAgent`'s signature gains a new parameter),
  `apps/hermes/src/agent/with-required-scopes.ts` (`describeConnectCommand`
  gains a new branch), `apps/hermes/src/boot.ts` (new `buildCalendarDeps`
  block, new arg passed to `buildAgent`), `apps/hermes/src/handlers/
  connect.ts` (`USAGE_TEXT` string gains a clause). If Gmail lands
  concurrently, expect line-adjacent merge conflicts on these files, not
  logic conflicts — resolve by keeping both additions, never by picking one
  side.
- **`buildAgent`'s new `calendarDeps` parameter must be inserted immediately
  before the trailing defaulted `logger: Logger = createLogger()` param**
  (TS requires non-default params before defaulted ones) — not appended
  after it. If Gmail's own PRD needs the same treatment for a `gmailDeps`
  param, whichever lands second adjusts the insertion point; this is a minor,
  expected coordination cost, not a design flaw.
- **Live external writes.** `reschedule_event`/`cancel_event` mutate a real
  user's real calendar; the approval prompt's `prepare()`-built summary is
  the only thing standing between a misread instruction and an unwanted
  change — its correctness (real old→new time, real event title) matters
  more than usual.
- **User-facing strings are Spanish**, matching `sheets_write`'s existing
  convention (e.g. `"El rango es muy grande..."`). All new approval
  summaries, refusal reasons, and notes follow that convention.
- **Order-sensitive:** Phase 1 (scaffold) before any wiring phase; Phase 2
  (`list_events` + scope upgrade) before Phases 3–6, since it proves the
  OAuth/wiring path end to end first and is the only phase every later one
  structurally depends on (event `id`s the write tools reference come from
  it).
- **Unbounded window risk.** Nothing about `maxResults` bounds a
  freebusy/list *time window* — only the result count. A bad relative-time
  resolution (an inverted range, or a multi-year span from a malformed
  intent) could send Google an oversized or backwards query. Phase 1 adds
  `window-bounds.ts`'s `validateTimeWindow(startUtc, endUtc, { maxDays })`
  (rejects `startUtc >= endUtc` and windows over a fixed cap), called by
  every tool that resolves a window (`list_events`, `find_free_slot`,
  `check_availability`) before any Google call — a bad window fails closed
  with a clear reason, never reaches the API.
- **Token expiry between `prepare()`'s pre-read and `handler()`'s write is
  not a race.** Each independently calls `AccessTokenPort.getAccessToken`,
  which goes through the shared `RefreshCoordinator` — a token expiring in
  between is refreshed transparently, the same pattern `sheets_write` already
  relies on. No special-casing needed.

## Phases

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Create a git worktree for this plan's branch. Always confirm worktree
creation with the user before running.

**Steps:**

- [ ] Confirm branch name (`feat/08-calendar`) and base ref (`main`) with the user
- [ ] Run `git worktree add ../hermes-08-calendar -b feat/08-calendar main`
- [ ] Verify worktree is active and on the correct branch (`git worktree list`)

---

### Phase 1: `@hermes/google-calendar` package scaffold — REST client, timezone + relative-time resolvers

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** the package builds, typechecks, and its client/resolver
logic is fully unit-tested against a mocked `fetch` and fixed clock — but
nothing is wired into the bot yet. **This is the plan's one allowed
vertical-slice exception** (`plan-sequential`'s "pure infrastructure
prerequisite, zero user-facing surface, at most one thin phase before the
first feature slice"): Phase 2 is the first phase a user/QA can actually
exercise.
**Commit message:** `feat(google-calendar): scaffold package, REST client, timezone + relative-time resolvers`

**File changes:**

| Action | File | What changes |
|---|---|---|
| create | `packages/google-calendar/package.json` | `@hermes/google-calendar`; deps `@hermes/core` (workspace:*), `zod` (^3.25.0), `luxon` (^3.5.0); scripts `typecheck`/`build`/`test` mirroring `packages/google-sheets/package.json` exactly |
| create | `packages/google-calendar/tsconfig.json` | extends `../../tsconfig.base.json`, `outDir: dist`, `include: ["src"]` |
| modify | `tsconfig.base.json` | add `"@hermes/google-calendar": ["packages/google-calendar/src/index.ts"]` to `paths` (additive) |
| create | `packages/google-calendar/src/access-token-port.ts` | `AccessTokenPort { getAccessToken(channel, channelUserId): Promise<string> }` — declared here per the consumer-declares-its-port convention, mirroring `google-sheets/src/access-token-port.ts`'s doc comment |
| create | `packages/google-calendar/src/calendar-client.ts` | thin `fetch`-based REST client over Calendar API v3, `createCalendarClient(opts?: { fetchImpl?: typeof fetch })`. Methods: `getPrimaryCalendarTimeZone`, `listEvents`, `getEvent`, `queryFreeBusy`, `insertEvent` (accepts a caller-supplied `id`), `patchEvent`, `deleteEvent`. Uses `withHttpRetry`/`RetryClassConfig` from `@hermes/core` exactly like `sheets-client.ts`'s `getWithRetry`/`sendWriteRequestWithRetry` — but unlike `sendWriteRequestWithRetry`, `insertEvent` uses the *same freely-retried* policy as reads (no `AmbiguousWriteError` split), because the caller-supplied `id` + 409-means-already-created makes a retried insert safe by construction. `listEvents` passes the schema's `maxResults` (≤50) straight through to the API's own `maxResults` query param — a single bounded request, no client-side pagination loop. `insertEvent`/`patchEvent` take a fixed, whitelisted TS parameter type (`{ id?, summary, description?, start, end }`), never a passthrough object — see the recurring-events scoping note in Context. `CalendarApiError extends Error` (`status`, `retryAfter`), same shape as `SheetsApiError`. No `googleapis` SDK. |
| create | `packages/google-calendar/src/timezone-cache.ts` | `resolveUserTimeZone(deps: { calendarClient, accessTokenPort }, channel, channelUserId, signal): Promise<string>` — in-process `Map<string, {timeZone, expiresAt}>` keyed by `${channel}:${channelUserId}`, TTL `TIMEZONE_CACHE_TTL_MS = 6h` (calendar timezone changes are rare); on miss/expiry, fetches an access token and calls `getPrimaryCalendarTimeZone`, then caches |
| create | `packages/google-calendar/src/relative-time.ts` | pure functions, no I/O. `RelativeTimeIntent { relativeDay?: "today"\|"tomorrow"\|"yesterday"\|"this_week"\|"next_week"; weekday?: Weekday; timeOfDay?: "morning"\|"afternoon"\|"evening"\|"night" }`; `resolveRelativeInstant(intent, nowUtcIso, timeZone): string` (a UTC ISO instant, defaulting to a sensible hour per `timeOfDay` — morning=09:00, afternoon=14:00, evening=18:00, night=21:00 local); `resolveRelativeWindow(intent, nowUtcIso, timeZone): { startUtc, endUtc }` (a day/week-bounded window for list/freebusy queries). Built on `luxon`'s `DateTime.fromISO(..., { zone: timeZone })`. |
| create | `packages/google-calendar/src/window-bounds.ts` | `validateTimeWindow(startUtc: string, endUtc: string, opts?: { maxDays?: number }): { ok: true } \| { ok: false; reason: "inverted_window" \| "window_too_large" }` — pure guard; default `maxDays = 31`. Called by every tool that resolves or accepts a window (`list_events`, `find_free_slot`, `check_availability`) before any Google call, whether the window came from `resolveRelativeWindow` or explicit `startIso`/`endIso` args |
| create | `packages/google-calendar/src/deterministic-event-id.ts` | `deriveEventId(turnId: string, canonicalArgs: unknown): string` — delegates canonicalization + hashing to the new `@hermes/core` export below (no bespoke encoding logic); a SHA-256 hex digest (`0`–`9`, `a`–`f`) is already a valid base32hex string (`0`–`9`, `a`–`v`) and well within the 5–1024 length bound Calendar's `id` field requires. Same `(turnId, canonicalArgs)` within the same turn yields the same id; a different turn or different args yields a different one. |
| create | `packages/core/src/canonical-hash.ts` | **new, additive** export `sha256HexOfCanonicalJson(value: unknown): string`, extracting the `sortKeysDeep` + deterministic-stringify + SHA-256-hex pattern already implemented in `packages/google-sheets/src/canonical-args.ts`'s `canonicalizeArgs`/`computeDedupeKey`. Exported (additive, one new line) from `packages/core/src/index.ts`. **`google-sheets` itself is left untouched** — migrating its own `canonical-args.ts` to call the shared helper is a follow-up cleanup, not in scope here; this plan only adds a new, unused-by-Sheets export so `google-calendar` (a peer package with no import path to `google-sheets`) can reuse the same algorithm instead of writing a second one. |
| create | `packages/google-calendar/src/tools/tool-deps.ts` | `CalendarToolDeps { accessTokenPort: AccessTokenPort; calendarClient: CalendarClient }`; `CalendarToolContext { signal, channel, channelUserId, turnId }` — mirrors `SheetsToolDeps`/`SheetsToolContext` exactly |
| create | `packages/google-calendar/src/index.ts` | barrel: `AccessTokenPort` type, `createCalendarClient`/`CalendarApiError`/client result types, `resolveUserTimeZone`, `resolveRelativeInstant`/`resolveRelativeWindow`/`RelativeTimeIntent`, `validateTimeWindow`, `deriveEventId`, `CalendarToolDeps`/`CalendarToolContext` — no tool exports yet, none exist |
| create | `packages/google-calendar/README.md` | package purpose, port shape, scope required, mirrors `packages/google-sheets/README.md`'s structure |
| create | `.ai/decisions/luxon-timezone-library.md` | load-bearing + low-risk justification, same Markdown shape as `.ai/decisions/google-auth-library-dependency.md` (`# Title`, `**Decision:**`, `**Why:**`, `**Rejected:**` — hand-rolled tz/DST math, `date-fns`/`dayjs` — , `**Constraints it creates:**` — used only inside `google-calendar`, never a reason to widen scope elsewhere) |
| create | `.ai/decisions/calendar-event-idempotency.md` | records the correction from decision 6's originally-stated `iCalUID` mechanism to the actually-implemented client-supplied event `id` mechanism; states precisely what it protects (same-turn duplicate tool calls, safe automatic write-retry via `withHttpRetry`) and what it does **not** need to protect (Telegram approval double-tap, already closed by the approval gate's synchronous single-resolve); notes no cross-tenant collision risk (`id` uniqueness is scoped per-calendar, each insert authenticated as its own user); notes reuse of `google-sheets`'s canonicalization algorithm via the new `@hermes/core` export rather than a new encoder. Created here, in Phase 1, alongside the code it justifies — not deferred to Phase 7 closeout. |

**Steps:**

- [x] Scaffold `package.json`/`tsconfig.json`; add the path mapping to root `tsconfig.base.json`
- [x] `pnpm add luxon` in `packages/google-calendar` (types ship with the package)
- [x] Implement `calendar-client.ts` — all seven REST methods, `withHttpRetry` wiring matching `sheets-client.ts`'s retry-class config (`rateLimit`/`transient`); `insertEvent` uses the freely-retried (read-like) policy, not a split ambiguous-write policy
- [x] Add `sha256HexOfCanonicalJson` to `packages/core/src/canonical-hash.ts` (additive export, `packages/core` unaffected otherwise; `google-sheets` untouched)
- [x] Implement `deterministic-event-id.ts` on top of the new core export
- [x] Implement `relative-time.ts` — `resolveRelativeInstant`, `resolveRelativeWindow`
- [x] Implement `window-bounds.ts` — `validateTimeWindow`
- [x] Implement `timezone-cache.ts` with TTL
- [x] Write `index.ts` barrel
- [x] Write `README.md`
- [x] Write `.ai/decisions/luxon-timezone-library.md`
- [x] Write `.ai/decisions/calendar-event-idempotency.md`
- [x] `pnpm -r typecheck` and `pnpm --filter @hermes/google-calendar test` both clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/__tests__/calendar-client.test.ts` | each REST method against a mocked `fetch` — success shapes, non-ok → `CalendarApiError` with status/retryAfter, retry-classification for 429/5xx, `insertEvent` sending the caller-supplied `id` |
| create | `packages/google-calendar/src/__tests__/relative-time.test.ts` | every `relativeDay`/`weekday`/`timeOfDay` combination against a fixed `nowUtcIso`; at least one case straddling a real DST transition (e.g. `America/New_York`, spring-forward date) to prove luxon zone math, not naive UTC offset math, is in effect |
| create | `packages/google-calendar/src/__tests__/timezone-cache.test.ts` | cache hit (no client call), miss (client called, result cached), TTL expiry (client called again after expiry) |
| create | `packages/google-calendar/src/__tests__/deterministic-event-id.test.ts` | same `(turnId, args)` → same id; different `turnId` or different `args` → different id; output matches the base32hex/length constraints; delegates to `sha256HexOfCanonicalJson` (key order in `canonicalArgs` doesn't change the id) |
| create | `packages/core/src/__tests__/canonical-hash.test.ts` | key-order independence; stable across repeated calls; produces a lowercase hex string |
| create | `packages/google-calendar/src/__tests__/window-bounds.test.ts` | valid window passes; `startUtc === endUtc` and `startUtc > endUtc` both rejected as `inverted_window`; a window past `maxDays` rejected as `window_too_large`; a window exactly at the boundary passes |

**Verification:**

- [x] `pnpm --filter @hermes/google-calendar test` passes
- [x] `pnpm -r typecheck` passes
- [x] `pnpm -r build` passes (package builds cleanly with the rest of the monorepo)
- No wiring/integration verification — nothing is reachable from the bot yet; that starts Phase 2.

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Code-reviewer agent has verified this phase (verdict: green)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (nits noted, non-blocking, no changes required)
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md, `.ai/decisions/luxon-timezone-library.md`)
- [ ] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(google-calendar): scaffold package, REST client, timezone + relative-time resolvers`
- [ ] Phase marked complete

---

### Phase 2: `/connect google calendar` + `list_events` — "what's on tomorrow?" works end to end

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** a user runs `/connect google calendar` in Telegram,
completes Google's consent screen, then asks "what's on tomorrow?" (or "what
do I have today?") and the bot replies with their real events, rendered in
their own timezone. This is the roadmap's first named exit criterion.
**Commit message:** `feat(google-calendar): wire OAuth calendar scope + list_events tool end to end`

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | add `CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]`; add `if (normalized === "calendar") return [...IDENTITY_SCOPES, ...CALENDAR_SCOPES];` in `resolveConnectScopes` (before the final `return undefined`); add `["list_events", CALENDAR_SCOPES]` to `TOOL_REQUIRED_SCOPES` (additive — other 5 tool rows land in their own phases) |
| modify | `apps/hermes/src/handlers/connect.ts` | `USAGE_TEXT` gains a clause: `"Usage: /connect google, /connect google sheets, or /connect google calendar"` |
| modify | `apps/hermes/src/agent/with-required-scopes.ts` | `describeConnectCommand`: add a `CALENDAR_SCOPES` branch (import from `@hermes/google-auth`) — check sheets first, then calendar, else identity; returns `"run /connect google calendar"` when the gated tool needs `CALENDAR_SCOPES` |
| modify | `apps/hermes/package.json` | add `"@hermes/google-calendar": "workspace:*"` to `dependencies`, mirroring the existing `@hermes/google-sheets` entry. **Omitted from the original draft.** Without it `apps/hermes` imports a package it never declares: `tsconfig.base.json`'s path mapping keeps `typecheck` green, so the gap only surfaces at build/runtime under pnpm's strict `node_modules` layout — a failure no phase gate in this plan would catch. |
| create | `apps/hermes/src/google/build-calendar-access-token-port.ts` | mirrors `build-access-token-port.ts` exactly, typed against `@hermes/google-calendar`'s `AccessTokenPort`, bound to the same shared `RefreshCoordinator` instance boot.ts already holds (never a second coordinator — settled decision 18 from `04-google-auth`) |
| modify | `apps/hermes/src/boot.ts` | add `buildCalendarDeps(pool, googleAccountRepo, coordinator): CalendarToolDeps`, mirroring `buildSheetsDeps` (unconfigured-Google fallback throws the same style of error); call it in `createMessageHandlers`, pass `calendarDeps` into `buildAgent` |
| modify | `apps/hermes/src/agent/build-agent.ts` | import `CalendarToolDeps`, `createCalendarListEventsTool`; `buildAgent` gains `calendarDeps: CalendarToolDeps` inserted immediately before the trailing `logger: Logger = createLogger()` param; construct `listEventsTool = withRequiredScopes("list_events", { googleAccountRepo, requiredScopes: requiredScopesFor("list_events") })(createCalendarListEventsTool(calendarDeps))`; append `listEventsTool` to the end of the `tools` array (after `sheetsWriteTool`) |
| create | `packages/google-calendar/src/tools/calendar-list-events.ts` | `createCalendarListEventsTool(deps)` — see schema/behavior below |
| create | `packages/google-calendar/src/render-event-time.ts` | `renderEventTime(event: { start: {date?: string; dateTime?: string}; end: {date?: string; dateTime?: string} }, timeZone): { allDay: boolean; startUtc?: string; endUtc?: string; localLabel: string }` — pure function branching on `date` (all-day) vs `dateTime` (timed); all-day events render a plain date label, no timezone conversion attempted. Shared by `list_events` here and `check_availability`'s conflict display in Phase 3. |
| modify | `packages/google-calendar/src/index.ts` | export `createCalendarListEventsTool`, `renderEventTime` |
| modify | `packages/google-calendar/README.md` | document `list_events` |
| modify | `.ai/index.md` | new Modules row: `google-calendar` |

**`list_events` tool design:**

- `name: "list_events"`, `requiresApproval: false`, no `prepare` (ungated read, no Google call needed to decide whether to run it — the scope gate alone protects it).
- Schema (flat zod object, matching the `sheets_read` convention;
  `.strict()` — see the recurring-events structural-scoping note in Context):
  ```ts
  z.object({
    relativeDay: z.enum(["today", "tomorrow", "yesterday", "this_week", "next_week"]).optional(),
    weekday: z.enum(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]).optional(),
    timeOfDay: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  }).strict()
  ```
  If `startIso`/`endIso` are both given they win outright; otherwise the
  intent fields resolve via `resolveRelativeWindow`; if neither is given,
  default to `{ relativeDay: "today" }`. Either way, the resolved window is
  passed through `validateTimeWindow` before any Google call; a rejected
  window returns `{ ok: false, reason: "inverted_window" | "window_too_large" }`,
  never reaches `listEvents`.
- Handler: resolve the user's timezone (`resolveUserTimeZone`), resolve and
  validate the window, fetch an access token, call
  `calendarClient.listEvents(accessToken, { timeMinIso, timeMaxIso,
  maxResults }, signal)` — `maxResults` (≤50) is passed straight to the
  Calendar API's own `maxResults` param, so this is always a single bounded
  request, no pagination loop. Each returned event's `description` field is
  truncated to 500 chars with a trailing `"… (truncado)"` marker if longer (a
  lightweight, single-field guard — the full dual-cap accumulator from
  `bounded-tool-results.md` is Sheets-scoped and not needed here since
  `maxResults` already bounds the list itself; see Context. Note this 50-item
  ceiling is a fresh judgment call for this package, not derived from
  Sheets' byte-size caps — a different axis, no direct precedent). Each
  event's `start`/`end` is rendered via `renderEventTime` — all-day events
  render as a plain date, never crash attempting to parse a missing
  `dateTime`.
- Result: `{ ok: true, timeZone, range: { startUtc, endUtc }, events: [{ id, summary, start, end, description? }] }` — **`id` is always present**; it's the only handle a later `reschedule_event`/`cancel_event` call has for "which event." Each `start`/`end` is rendered as both the raw UTC ISO and a human string in the user's zone (e.g. `"2026-09-07T14:00:00-04:00"` local-offset ISO is sufficient; no separate free-text formatting layer) for timed events, or a plain date for all-day events (see `renderEventTime`).

**Steps:**

- [x] `scopes.ts`: add `CALENDAR_SCOPES`, `resolveConnectScopes` branch, `TOOL_REQUIRED_SCOPES` row
- [x] `connect.ts`: update `USAGE_TEXT`
- [x] `with-required-scopes.ts`: add calendar branch to `describeConnectCommand`
- [x] Create `build-calendar-access-token-port.ts`
- [x] Add `"@hermes/google-calendar": "workspace:*"` to `apps/hermes/package.json` dependencies, then `pnpm install`
- [x] `boot.ts`: add `buildCalendarDeps`, wire into `createMessageHandlers`/`buildAgent` call
- [x] `build-agent.ts`: widen `buildAgent` signature, construct + append `listEventsTool`
- [x] Implement `render-event-time.ts`
- [x] Implement `calendar-list-events.ts` (incl. window validation, all-day-safe rendering)
- [x] Update `index.ts`, `README.md`, `.ai/index.md`
- [x] `pnpm -r typecheck` clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/tools/__tests__/calendar-list-events.test.ts` | explicit `startIso`/`endIso` wins over intent fields; each intent-field combination resolves the expected window (via a fake clock); `maxResults` clamped 1–50; description truncation at 500 chars; result always includes `id` per event; an inverted or oversized window is refused before any client call is made; an all-day event (`start.date`, no `dateTime`) in a mocked API response renders without throwing and without a timezone-converted time |
| create | `packages/google-calendar/src/__tests__/render-event-time.test.ts` | timed event renders raw UTC + local-offset ISO; all-day event renders a plain date, `allDay: true`, no timezone math attempted |
| modify | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | `buildAgent`'s `tools` array includes `list_events`; wired with the right required scopes |
| create | `apps/hermes/src/agent/__tests__/calendar-tools-fail-closed.test.ts` | mirrors `sheets-tools-fail-closed.test.ts`: an account with only identity scopes (or no account at all) gets the `missing_scope`/`not_connected` refusal with `fix: "run /connect google calendar"` from `list_events`, no Google API call made |
| modify | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | `describeConnectCommand` returns `"run /connect google calendar"` for a `CALENDAR_SCOPES` requirement |
| modify | `packages/google-auth/src/__tests__/scopes.test.ts` | `resolveConnectScopes("calendar")` returns `[...IDENTITY_SCOPES, ...CALENDAR_SCOPES]`; case/whitespace-insensitive, matching the existing `"sheets"` test cases |

**Verification:**

- [x] `pnpm --filter @hermes/google-calendar test`, `pnpm --filter hermes test` (or repo equivalent for `apps/hermes`) pass
- [x] `pnpm -r typecheck` passes
- [x] **Manual (hil, cannot be automated):** against the real bot, run `/connect google calendar`, complete Google's live consent screen, confirm the granted-scope check passes; then ask "what's on tomorrow?" and confirm the reply lists real events (or "no events" if the calendar is empty) rendered in the account's actual timezone — confirmed by orchestrator against the `feat/08-calendar` worktree stack (main-branch stack was stopped, worktree rebuilt with fresh Postgres, `/connect google calendar` + "what's on tomorrow?" both worked)
- [x] Manual: an account that only ran `/connect google` (no calendar scope) asking a calendar question gets the "run /connect google calendar" refusal, not an error — covered by the automated `calendar-tools-fail-closed.test.ts` (passing); not re-verified live separately

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Code-reviewer agent has verified this phase (verdict: yellow → blocking finding fixed → re-verified additive-only, verdict now clean)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md, `.ai/index.md`)
- [x] Orchestrator (user) has verified and approved this phase, including the manual OAuth/live-bot check
- [x] Changes committed: `feat(google-calendar): wire OAuth calendar scope + list_events tool end to end`
- [x] Phase marked complete

---

### Phase 3: `find_free_slot` + `check_availability` — "am I free Thursday afternoon?"

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** a user asks "find me a free 30-minute slot tomorrow
morning" and gets a real candidate time back; a user asks "am I free at 3pm
Thursday?" and gets a real yes/no with the conflicting event named if not.
**Commit message:** `feat(google-calendar): add find_free_slot and check_availability tools`

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["find_free_slot", CALENDAR_SCOPES]` and `["check_availability", CALENDAR_SCOPES]` |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct + append `findFreeSlotTool`, `checkAvailabilityTool` (same `withRequiredScopes(...)` wrapping pattern as `listEventsTool`) |
| create | `packages/google-calendar/src/tools/calendar-find-free-slot.ts` | `createCalendarFindFreeSlotTool(deps)` |
| create | `packages/google-calendar/src/tools/calendar-check-availability.ts` | `createCalendarCheckAvailabilityTool(deps)` |
| modify | `packages/google-calendar/src/index.ts` | export both new tool factories |
| modify | `packages/google-calendar/README.md` | document both tools |

**Design:**

- Both are `requiresApproval: false`, no `prepare`, same
  `resolveUserTimeZone` + `resolveRelativeWindow`/`resolveRelativeInstant`
  pattern as `list_events`.
- `find_free_slot` schema (`.strict()`, same as `list_events`): `{ relativeDay?,
  weekday?, timeOfDay?, startIso?, endIso?, durationMinutes:
  z.number().int().min(5).max(480).default(30) }`.
  The resolved window is passed through `validateTimeWindow` (same guard as
  `list_events`) before querying freebusy — an inverted or oversized search
  window is refused, never sent to Google. Calls `calendarClient.queryFreeBusy`
  over the resolved (and now-bounded) window, computes gaps ≥
  `durationMinutes` between busy intervals, returns up to 5 candidate
  `{ startUtc, endUtc }` slots rendered in the user's zone.
- `check_availability` schema (`.strict()`): `{ relativeDay?, weekday?, timeOfDay?,
  startIso?, endIso?, durationMinutes: z.number().int().min(5).max(480).default(30)
  }` — resolves a single instant (or explicit window) rather than a search
  window, validates `[instant, instant + durationMinutes]` with the same
  guard, queries freebusy over it, returns `{ ok: true, available: boolean,
  conflicts?: [{ id, summary, start, end }] }`. Conflict entries render their
  `start`/`end` via `renderEventTime` (Phase 2), so an all-day event
  reported as a conflict doesn't crash the response either.
- Freebusy responses are inherently small (a list of busy intervals within a
  bounded window) — no truncation logic needed, matching the Context note
  about not porting Sheets' dual-cap accumulator. The window bound above is a
  size guard on the *query*, not a truncation of the *response*.

**Steps:**

- [x] `scopes.ts`: add the two `TOOL_REQUIRED_SCOPES` rows
- [x] Implement `calendar-find-free-slot.ts`
- [x] Implement `calendar-check-availability.ts`
- [x] `build-agent.ts`: construct + append both tools
- [x] Update `index.ts`, `README.md`
- [x] `pnpm -r typecheck` clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/tools/__tests__/calendar-find-free-slot.test.ts` | gap computation against a fixed freebusy fixture (busy blocks with gaps of varying size); a window with no gap ≥ `durationMinutes` returns an empty candidate list, not an error; `durationMinutes` clamped 5–480; an inverted/oversized resolved window is refused before `queryFreeBusy` is called |
| create | `packages/google-calendar/src/tools/__tests__/calendar-check-availability.test.ts` | available (no overlap) vs. unavailable (overlap, conflict named) against a fixed freebusy/list fixture; an all-day event as the reported conflict renders without throwing |

**Verification:**

- [x] `pnpm --filter @hermes/google-calendar test` passes
- [x] `pnpm -r typecheck` passes
- [x] Manual: against the real bot, "find me a free 30 min slot tomorrow morning" and "am I free Thursday at 3?" both return real, correct answers — confirmed by orchestrator against the rebuilt `feat/08-calendar` worktree stack

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Code-reviewer agent has verified this phase (verdict: green)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (nits only, no changes required — one-candidate-per-gap design judged faithful to plan wording)
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(google-calendar): add find_free_slot and check_availability tools`
- [x] Phase marked complete

---

### Phase 4: `create_event` — approval-gated event creation, idempotent by construction

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** a user says "schedule lunch with Alex tomorrow at
noon" → an approval prompt in Spanish shows the real title and the real local
time → approving creates a real event on the calendar; the model emitting the
same `create_event` call twice in one turn, or the client transparently
retrying an ambiguous insert failure, never creates a duplicate (double-tap
on the approval button itself is already prevented upstream by the Telegram
approval gate's single-resolve semantics — this mechanism is not that).
**Commit message:** `feat(google-calendar): add approval-gated create_event tool`

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["create_event", CALENDAR_SCOPES]` |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct `createEventTool = withRequiredScopes<CreateEventPlan>("create_event", {...})(createCalendarCreateEventTool(calendarDeps))`; append to `tools` array |
| create | `packages/google-calendar/src/tools/calendar-create-event.ts` | `createCalendarCreateEventTool(deps)` — schema, `prepare`, `handler` below |
| modify | `packages/google-calendar/src/index.ts` | export `createCalendarCreateEventTool`, `CreateEventPlan` |
| modify | `packages/google-calendar/README.md` | document `create_event` |
| create | `packages/google-calendar/src/format-approval-time.ts` | **Added post-review, from live hil testing.** `formatApprovalTimeRangeEs(startUtc, endUtc, timeZone): string` — legible Spanish time-range label for approval-summary display only (e.g. `"martes 8 de septiembre, 12:00 – 13:00"`), distinct from `renderEventTime`'s ISO `localLabel` (which stays correct/untouched for `list_events`/`find_free_slot`/`check_availability`'s JSON tool results). Reused by Phases 5–6's approval targets — see their Design notes. |

**Design:**

- Schema (`.strict()` — defense-in-depth against a stray field like
  `recurrence`/`attendees` reaching even validation, on top of
  `calendar-client.ts`'s fixed whitelisted parameter type):
  ```ts
  z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    relativeDay: z.enum([...]).optional(),
    weekday: z.enum([...]).optional(),
    timeOfDay: z.enum([...]).optional(),
    startIso: z.string().optional(),
    durationMinutes: z.number().int().min(5).max(1440).default(60),
    endIso: z.string().optional(),
  }).strict()
  ```
- `prepare(args, ctx)`: resolve the user's timezone; resolve `startUtc` (explicit `startIso` wins, else `resolveRelativeInstant`); compute `endUtc` (explicit `endIso` wins, else `startUtc + durationMinutes`); derive `eventId = deriveEventId(ctx.turnId, { summary, startUtc, endUtc })`. No Google call — everything needed is already resolvable locally, so this stays as cheap as `sheets_write`'s Tier-1 prepare (Postgres-only), just with zero I/O at all. Returns:
  ```ts
  {
    ok: true,
    plan: { eventId, summary, description, startUtc, endUtc },
    summary: {
      action: `Crear evento: "${summary}"`,
      target: `${localStart} – ${localEnd}`,   // rendered in the user's timezone
      effects: ["Se creará un evento nuevo en tu calendario principal."],
    },
  }
  ```
- `handler(args, ctx & { plan })`: fetch access token; call
  `calendarClient.insertEvent(accessToken, { id: plan.eventId, summary:
  plan.summary, description: plan.description, start: plan.startUtc, end:
  plan.endUtc }, signal)`. On `CalendarApiError` with `status === 409`, treat
  as already-created: `calendarClient.getEvent(accessToken, plan.eventId,
  signal)` and return that event (idempotent, no duplicate, no error
  surfaced to the model). Otherwise return the inserted event.

**Steps:**

- [x] `scopes.ts`: add `create_event` row
- [x] Implement `calendar-create-event.ts` (schema, `prepare`, `handler`, 409-idempotent-retry handling)
- [x] `build-agent.ts`: construct + append `createEventTool`
- [x] Update `index.ts`, `README.md`
- [x] `pnpm -r typecheck` clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/tools/__tests__/calendar-create-event.test.ts` | `prepare` resolves relative and explicit times identically to `list_events`'s resolution; `ApprovalSummary` shape/content (action names the title, target shows local start–end, one effect sentence); `eventId` is stable across two `prepare` calls with the same `turnId`+args and different across a different `turnId`; `handler` on a fresh insert returns the created event; `handler` on a mocked 409 fetches and returns the existing event instead of throwing (the idempotent-retry path) |

**Verification:**

- [x] `pnpm --filter @hermes/google-calendar test` passes
- [x] `pnpm -r typecheck` passes
- [x] Manual: against the real bot, "schedule lunch with Alex tomorrow at noon" produces a Spanish approval prompt with the real title/time; approving creates a real, visible event on the connected Google Calendar; denying creates nothing — first pass surfaced an illegible-time-format bug (raw ISO in the approval prompt), fixed in commit `b8f3f24`; re-verified against the rebuilt worktree stack, legible Spanish date/time confirmed

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] Code-reviewer agent has verified this phase (verdict: green; a separate live-testing defect was found and fixed after review — see `b8f3f24`)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (review nits: no changes required; live-testing fix: documented above and propagated to Phase 5/6 design notes)
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat(google-calendar): add approval-gated create_event tool` (`a7b5b5c`), `fix(google-calendar): render create_event approval time range in legible Spanish, not raw ISO` (`b8f3f24`)
- [x] Phase marked complete

---

### Phase 5: `reschedule_event` — "move my 3pm to Thursday 10am" works end to end

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** the user asks the bot what's on today (`list_events`),
then says "move my 3pm to Thursday 10am" — the bot resolves which event via
the `id` it already surfaced, shows an approval prompt with the real
old-time → new-time, and approving actually moves the event. This is the
roadmap's second named exit criterion.
**Commit message:** `feat(google-calendar): add approval-gated reschedule_event tool with pre-read diff`

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["reschedule_event", CALENDAR_SCOPES]` |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct + append `rescheduleEventTool` |
| create | `packages/google-calendar/src/tools/calendar-reschedule-event.ts` | `createCalendarRescheduleEventTool(deps)` |
| modify | `packages/google-calendar/src/index.ts` | export `createCalendarRescheduleEventTool`, `RescheduleEventPlan` |
| modify | `packages/google-calendar/README.md` | document `reschedule_event` |

**Design:**

- Schema (`.strict()`):
  ```ts
  z.object({
    eventId: z.string().min(1),
    relativeDay: z.enum([...]).optional(),
    weekday: z.enum([...]).optional(),
    timeOfDay: z.enum([...]).optional(),
    startIso: z.string().optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    endIso: z.string().optional(),
  }).strict()
  ```
  (`durationMinutes` optional and, if omitted, preserves the event's current
  duration — computed from the pre-read.) The resolved new `startUtc`/`endUtc`
  is also passed through `validateTimeWindow` before `patchEvent` is called —
  same guard as the read tools, so a malformed relative-time resolution can't
  silently move an event to an inverted or absurdly long span either.
- `prepare(args, ctx)`: fetch access token; `event =
  calendarClient.getEvent(accessToken, args.eventId, signal)` — the one
  bounded pre-read decision 3 calls for. If the event isn't found (404),
  return `{ ok: false, result: { ok: false, reason: "event_not_found" } }`
  — fail closed, no approval prompt for a nonexistent event, same posture as
  Sheets' unknown-slug refusal. Otherwise resolve the user's timezone, the
  new `startUtc` (explicit or relative), the new `endUtc` (explicit `endIso`,
  or `startUtc + (explicit durationMinutes ?? event's current duration)`).
  Returns:
  ```ts
  {
    ok: true,
    plan: { eventId: args.eventId, newStartUtc, newEndUtc },
    summary: {
      action: `Mover "${event.summary}"`,
      target: `${oldLocalRange} → ${newLocalRange}`,
      effects: ["El evento se moverá a la nueva fecha y hora."],
    },
  }
  ```
  **Correction from live Phase 4 testing:** `oldLocalRange`/`newLocalRange`
  must be built with Phase 4's `formatApprovalTimeRangeEs(startUtc, endUtc,
  timeZone)` (`packages/google-calendar/src/format-approval-time.ts`), NOT
  `renderEventTime(...).localLabel`. A live user found the raw local-offset-ISO
  `localLabel` illegible in an approval prompt (Spanish, shown directly to a
  non-technical user before a real write) — `renderEventTime`'s ISO output
  stays correct and untouched for `list_events`/`find_free_slot`/
  `check_availability`'s JSON tool results, but every approval-summary
  `target`/`action` string in this plan must use the legible formatter
  instead. Old range comes from the pre-read `event`'s own start/end (rendered
  via `renderEventTime` first just to get UTC instants, or read directly if
  the API response already gives ISO strings — then formatted with
  `formatApprovalTimeRangeEs`); new range from `plan.newStartUtc`/
  `newEndUtc`.
- `handler(args, ctx & { plan })`: `calendarClient.patchEvent(accessToken,
  plan.eventId, { start: plan.newStartUtc, end: plan.newEndUtc }, signal)`,
  return the updated event.

**Steps:**

- [x] `scopes.ts`: add `reschedule_event` row
- [x] Implement `calendar-reschedule-event.ts` (schema, `prepare` incl. pre-read + not-found refusal, `handler`)
- [x] `build-agent.ts`: construct + append `rescheduleEventTool`
- [x] Update `index.ts`, `README.md`
- [x] `pnpm -r typecheck` clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/tools/__tests__/calendar-reschedule-event.test.ts` | `prepare` against a mocked existing event: old→new range in the `ApprovalSummary.target`; duration preserved when `durationMinutes` omitted; explicit `durationMinutes`/`endIso` overrides; `event_not_found` refusal on a mocked 404, no approval prompt data returned; a resolved new window that's inverted/oversized is refused before `patchEvent` is ever built into a plan; `handler` calls `patchEvent` with exactly the planned start/end |

**Verification:**

- [x] `pnpm --filter @hermes/google-calendar test` passes
- [x] `pnpm -r typecheck` passes
- [ ] Manual: against the real bot — ask "what's on today?", note a real event's time, then say "move my \<that time\> to Thursday 10am"; confirm the approval prompt shows the real old time → new time; approve; confirm the event's time actually changed on Google Calendar

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file (automated ones; manual live-bot check pending)
- [x] Code-reviewer agent has verified this phase (verdict: green; one nit — all-day-event refusal threw instead of failing closed — fixed in `d23432c`)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (README.md)
- [ ] Orchestrator (user) has verified and approved this phase, including the manual live-bot check
- [x] Changes committed: `feat(google-calendar): add approval-gated reschedule_event tool with pre-read diff` (`f44b8af`), `fix(google-calendar): fail closed instead of throwing when rescheduling an all-day event` (`d23432c`)
- [ ] Phase marked complete

---

### Phase 6: `cancel_event` — approval-gated cancellation with a real pre-read summary

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** the user says "cancel my 3pm meeting" (again chaining
off a prior `list_events` id) → an approval prompt names the real event and
time being cancelled → approving removes it from the calendar.
**Commit message:** `feat(google-calendar): add approval-gated cancel_event tool`

**File changes:**

| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | `TOOL_REQUIRED_SCOPES` gains `["cancel_event", CALENDAR_SCOPES]` |
| modify | `apps/hermes/src/agent/build-agent.ts` | construct + append `cancelEventTool` (last entry in the `tools` array) |
| create | `packages/google-calendar/src/tools/calendar-cancel-event.ts` | `createCalendarCancelEventTool(deps)` |
| modify | `packages/google-calendar/src/index.ts` | export `createCalendarCancelEventTool` |
| modify | `packages/google-calendar/README.md` | document `cancel_event`; this completes the package's tool list — do a final pass over the whole README for consistency |

**Design:**

- Schema: `z.object({ eventId: z.string().min(1) }).strict()`.
- `prepare(args, ctx)`: `event = calendarClient.getEvent(accessToken,
  args.eventId, signal)`; 404 → `{ ok: false, result: { ok: false, reason:
  "event_not_found" } }` (same fail-closed posture as reschedule). Otherwise:
  ```ts
  {
    ok: true,
    plan: { eventId: args.eventId },
    summary: {
      action: `Cancelar "${event.summary}"`,
      target: localRange,
      effects: ["El evento se eliminará de tu calendario principal."],
    },
  }
  ```
  **Same correction as Phase 5:** `localRange` must be built with
  `formatApprovalTimeRangeEs(startUtc, endUtc, timeZone)`
  (`packages/google-calendar/src/format-approval-time.ts`, added in the
  Phase 4 fix), not `renderEventTime(...).localLabel` — see Phase 5's note.
- `handler(args, ctx & { plan })`: `calendarClient.deleteEvent(accessToken,
  plan.eventId, signal)`. Calendar's `DELETE` on an already-deleted/unknown
  event id returns `410 Gone`/`404` — treat either as a successful no-op
  (the end state the user wanted — "gone" — already holds), not an error.

**Steps:**

- [ ] `scopes.ts`: add `cancel_event` row
- [ ] Implement `calendar-cancel-event.ts` (schema, `prepare` incl. pre-read + not-found refusal, `handler` incl. already-gone-is-success handling)
- [ ] `build-agent.ts`: construct + append `cancelEventTool`
- [ ] Update `index.ts`, final pass on `README.md`
- [ ] `pnpm -r typecheck` clean

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-calendar/src/tools/__tests__/calendar-cancel-event.test.ts` | `prepare` against a mocked existing event: summary/target correctly built; `event_not_found` refusal on a mocked 404; `handler` calls `deleteEvent` with the planned id; `handler` treats a mocked 404/410 on delete as success, not a thrown error |

**Verification:**

- [ ] `pnpm --filter @hermes/google-calendar test` passes
- [ ] `pnpm -r typecheck` passes
- [ ] Manual: against the real bot — "cancel my \<event\>" shows the real event/time in the approval prompt; approving removes it from Google Calendar; denying leaves it untouched

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (README.md)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat(google-calendar): add approval-gated cancel_event tool`
- [ ] Phase marked complete

---

### Phase 7: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- Both roadmap exit-criterion behaviors work end to end on the real bot:
  "what's on tomorrow?" and "move my 3pm to Thursday 10am".
- All six tools (`list_events`, `find_free_slot`, `check_availability`,
  `create_event`, `reschedule_event`, `cancel_event`) are reachable, scope-
  gated, and (for the three writes) approval-gated with legible Spanish
  prompts showing real resolved data, never raw JSON.
- An account without the calendar scope is refused with a clear
  `/connect google calendar` instruction, no Google call made.
- No shared file (`scopes.ts`, `build-agent.ts`, `with-required-scopes.ts`,
  `boot.ts`, `connect.ts`) has a non-additive edit that could conflict with a
  parallel Gmail PRD.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review have been reflected back into this plan file
- [ ] All tests pass (`pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`)
- [ ] No CLAUDE.md invariants violated (pnpm-only, thin entry points, reuse-before-reinvent, no circular deps, additive-only shared-file edits)
- [ ] Feature tested manually end to end on the real bot: connect → list → free-slot search → availability check → create → reschedule (the "3pm to Thursday 10am" case specifically) → cancel
- [ ] Overall success criteria met
- [ ] All phase checkboxes above are ticked
- [ ] `sync-knowledge` run to close out `.ai/` updates (see Knowledge Base Impact below)

## Documentation

| Change | Documentation location |
|---|---|
| New `@hermes/google-calendar` package (client, resolvers, ports) | `packages/google-calendar/README.md` (Phase 1, extended each phase a tool is added) |
| New calendar OAuth scope tier | `.ai/index.md`'s "Google OAuth + token lifecycle" cross-cutting row (Phase 2) |
| New module | `.ai/index.md` Modules table, new `google-calendar` row (Phase 2) |
| Six new tools, approval-gate usage | `.ai/architecture.md`'s "Tool approvals" cross-cutting section and package tree (Phase 7 closeout, via `sync-knowledge`) |
| luxon dependency | `.ai/decisions/luxon-timezone-library.md` (Phase 1) |
| Deterministic event-id idempotency mechanism (correction from `iCalUID` to custom `id`) | new `.ai/decisions/calendar-event-idempotency.md` (**Phase 1**, alongside `deterministic-event-id.ts`) — records the correction from the originally-proposed `iCalUID` mechanism to the client-supplied `id` mechanism; states precisely what it protects (same-turn duplicate calls, safe automatic write-retry) versus what's already handled upstream (approval-gate double-tap); records the reuse of `google-sheets`'s canonicalization algorithm via a new `@hermes/core` export |
| Shared canonicalization/hash helper extracted for reuse | `packages/core/src/canonical-hash.ts` (Phase 1) — additive export, no change to `google-sheets`'s own copy |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `google-calendar` Modules row; extend "Google OAuth + token lifecycle" and "Tool approvals" cross-cutting rows to mention Calendar |
| `architecture.md` | update | package tree gains `packages/google-calendar`; note the six new tools and that Calendar, unlike Sheets, has no DB-backed port (no registry, no write-log) |
| `decisions/luxon-timezone-library.md` | create | load-bearing+low-risk justification for the new luxon dependency (Phase 1) |
| `decisions/calendar-event-idempotency.md` | create | records the correction from decision 6's originally-stated `iCalUID` mechanism to the actually-implemented client-supplied event `id` mechanism, precisely what it protects vs. what's already handled by the approval gate, and the `@hermes/core` canonicalization reuse — created in **Phase 1**, not deferred to closeout |
| `decisions/defer-trading-journal.md` | none | already correctly states Phase 5 has no dependency on it — no change needed |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | Calendar REST client (all methods, retry/error classification) | `packages/google-calendar/src/__tests__/calendar-client.test.ts` |
| Phase 1 | Relative-time resolution, incl. DST correctness | `packages/google-calendar/src/__tests__/relative-time.test.ts` |
| Phase 1 | Timezone cache TTL behavior | `packages/google-calendar/src/__tests__/timezone-cache.test.ts` |
| Phase 1 | Deterministic event-id derivation | `packages/google-calendar/src/__tests__/deterministic-event-id.test.ts` |
| Phase 1 | Shared canonicalization/hash helper | `packages/core/src/__tests__/canonical-hash.test.ts` |
| Phase 1 | Time-window validation (inverted/oversized) | `packages/google-calendar/src/__tests__/window-bounds.test.ts` |
| Phase 2 | `list_events` window resolution, truncation, all-day safety | `packages/google-calendar/src/tools/__tests__/calendar-list-events.test.ts` |
| Phase 2 | All-day vs. timed event rendering | `packages/google-calendar/src/__tests__/render-event-time.test.ts` |
| Phase 2 | Calendar tool wiring, scope gating, fail-closed refusal | `apps/hermes/src/agent/__tests__/build-agent.test.ts`, `apps/hermes/src/agent/__tests__/calendar-tools-fail-closed.test.ts`, `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` |
| Phase 2 | `resolveConnectScopes("calendar")` | `packages/google-auth/src/__tests__/scopes.test.ts` |
| Phase 3 | Free-slot gap computation | `packages/google-calendar/src/tools/__tests__/calendar-find-free-slot.test.ts` |
| Phase 3 | Availability/conflict detection | `packages/google-calendar/src/tools/__tests__/calendar-check-availability.test.ts` |
| Phase 4 | `create_event` prepare/idempotent-retry/handler | `packages/google-calendar/src/tools/__tests__/calendar-create-event.test.ts` |
| Phase 5 | `reschedule_event` pre-read diff, not-found refusal, handler | `packages/google-calendar/src/tools/__tests__/calendar-reschedule-event.test.ts` |
| Phase 6 | `cancel_event` pre-read summary, not-found/already-gone handling | `packages/google-calendar/src/tools/__tests__/calendar-cancel-event.test.ts` |

## Human Summary

<!-- This section is for humans only — Claude should write it but not use it for execution. -->

This plan gives Hermes a real calendar. Today it can only read and write
spreadsheets; after this ships, it can also tell you what's on your day, find
you a free slot, check if you're busy, and — with your explicit approval each
time — create, move, or cancel events on your real Google Calendar.

The phases build in the order a person would actually use the feature:
first, connecting your calendar account and asking what's coming up
(Phase 1–2); then finding time and checking availability (Phase 3); then
actually changing your calendar, one capability at a time — creating events
(Phase 4), moving them (Phase 5, which is the "move my 3pm to Thursday 10am"
behavior this whole project was asked to deliver), and cancelling them
(Phase 6). Every phase after the first one is something you can actually try
on the real bot the day it ships, not an invisible piece of plumbing.

Two things make this simpler than the Sheets work that came before it: there's
only one calendar (yours, the primary one — no juggling multiple registered
calendars by slug), and there's no new database table anywhere in this plan.
Google's own calendar API gives Hermes a clean way to make event creation
safe to retry (a stable id it sets itself, so if the model asks to create the
same lunch twice in one request, or a flaky network makes Hermes resend the
request behind the scenes, you still only ever get one lunch on your
calendar) — no separate audit table needed the way Sheets needed one for its
writes. The trickiest part is under the hood: correctly
turning "tomorrow morning" or "next Thursday" into an exact moment in your own
timezone, done deterministically by code (not left to the model to guess),
using a small, well-tested date library rather than hand-rolled date math that
would quietly get daylight saving time wrong twice a year.

Every write still goes through the same approval prompt pattern Hermes
already uses for spreadsheets: before anything changes, you see — in plain
Spanish — exactly what's about to happen (the real event name, the real old
and new times), and nothing happens until you say yes.
