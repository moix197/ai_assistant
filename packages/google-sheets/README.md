# @hermes/google-sheets

The generic Google Sheets capability: read and write spreadsheets the
operator has pre-registered under short slugs. Nothing trading-specific
lives here — see `plans/05-google-sheets.md`'s Context. Phase 4 ships
`sheets_inspect` and `sheets_read` (read-only). Phase 5 adds `sheets_write`.

## Ports

Two consumer-declared ports, following `@hermes/google-auth`'s
`GoogleAccountRepo` convention — this package never imports `@hermes/store`
or `@hermes/google-auth` directly:

- `SheetRegistryPort { getBySlug(slug), listAll() }` (`sheet-registry-port.ts`)
  — bound in `apps/hermes/src/store/build-sheet-registry-repo.ts` to
  `@hermes/store`'s real Postgres-backed functions.
- `AccessTokenPort { getAccessToken(channel, channelUserId): Promise<string> }`
  (`access-token-port.ts`) — bound in `apps/hermes/src/google/
  build-access-token-port.ts` over `@hermes/google-auth`'s
  `RefreshCoordinator.getValidAccessToken`, the single refresh seam
  `04-google-auth` Phase 4 built specifically so a request-path tool call
  would never need a second refresh path (settled decision 18). The binding
  persists a changed account via the existing **UPDATE-only**
  `updateRefreshedTokens` — never an upsert, so a token refresh in flight can
  never resurrect an account `/disconnect` deleted meanwhile.

`SheetRegistryEntry` (the row shape) is declared in `@hermes/core`
(`google-types.ts`, Phase 3) and re-exported here, not redefined — the same
arrangement `GoogleAccount` already uses between `@hermes/google-auth` and
`@hermes/store`. This is deliberate: `04-google-auth`'s own Final
Verification had to fix a `store -> google-auth` sibling edge after the
fact; this plan puts the schema-first type in `core` from the start.

## The live-registry-read contract — never frozen at boot

`SheetRegistryPort`'s Postgres binding (`build-sheet-registry-repo.ts`) has
**no caching, no boot-time snapshot** — every `getBySlug`/`listAll` call
goes straight to the pool. A sheet's `access`/`value_input_option`, or a
newly-registered slug, is visible to the very next tool call, not just after
a restart (settled decision 5). `resolve-sheet.ts`'s `resolveSheet(registry,
sheet)` is the one place every Sheets tool looks a slug up — an unknown slug
(including an empty registry) returns `{ ok: false, reason: "unknown_sheet",
available: string[] }` (`available: []` for an empty registry, not an
error), and the calling tool returns that result directly rather than
duplicating the lookup-and-branch logic.

## `sheets-client.ts`

A thin `fetch`-based client over the Sheets v4 REST API, built on
`@hermes/core`'s `withHttpRetry` (`05-google-sheets` Phase 1) — no
`googleapis`, no new third-party HTTP client (settled decision 20; see
`.ai/decisions/` for the write-up). Two read methods:

- `getSpreadsheetMeta(accessToken, spreadsheetId, signal?)` — **two requests,
  not one**, and the reason is a Sheets API quirk worth knowing: an unqualified
  `ranges` parameter bounds only the *first* sheet, so a single
  `?fields=...&ranges=1:1` call would pull full `rowData` for every other tab.
  So: (1) `GET ?fields=sheets.properties` to learn the tab titles, then (2)
  `GET ?fields=sheets.properties,sheets.data.rowData.values.formattedValue` with
  one **fully-qualified** `ranges=<title>!1:1` per tab. Tab titles are A1-quoted
  (`quoteSheetTitle` — most real tab names contain spaces, so quoting is the
  common case, not an edge case). A spreadsheet with no tabs short-circuits
  after the first request. Backs `sheets_inspect`.
- `getValues(accessToken, spreadsheetId, range, valueRenderOption, signal?)`
  — `GET /v4/spreadsheets/{spreadsheetId}/values/{range}?valueRenderOption=...`.
  Backs `sheets_read`.

Own `classify` (429 → `rateLimit`, honoring `Retry-After`; 5xx →
`transient`; anything else fatal, thrown directly) and own `redact`
(strips the bearer token from any thrown message) — `withHttpRetry` itself
never touches request/response content, per its own contract. Reads carry no
write-ambiguity risk: `GET` is naturally idempotent, so both classes retry
freely within the tool's own timeout budget (settled decision 15 — the
retryable-vs-ambiguous split that decision also draws applies to
`sheets_write`'s mutating calls, Phase 5, not this read-only client).

Two write methods (Phase 5), backing `sheets_write`:

- `appendValues(accessToken, spreadsheetId, range, values, valueInputOption, insertDataOption?, signal?)`
  — `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=...&insertDataOption=...`,
  `insertDataOption` defaulting to `INSERT_ROWS`.
- `updateValues(accessToken, spreadsheetId, range, values, valueInputOption, signal?)`
  — `PUT /v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=...`.

Own `classifyWrite`/`sendWriteRequestWithRetry`, separate from the read
path's `classify`/`getWithRetry`: a fetch-level throw is `preSendNetwork`
(retryable, same posture as a 429) only when `error.cause.code` is one of a
small set of codes (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) that provably
mean the connection itself never got established. Everything else — a 5xx,
this client's own timeout `AbortError`, or a fetch-level throw whose
`cause.code` is anything else (a post-send socket reset/close) or has no
`cause` at all — is `postSendAmbiguous`, whose retry policy is supplied per
call. This distinction matters because Node/undici raise both a genuinely
pre-send failure and a post-send socket failure as the same indistinguishable
`TypeError: fetch failed`; only `cause.code` tells them apart, and when it
can't, the failure is treated as ambiguous (fail-safe), never as
safe-to-retry. See "`sheets_write` (Phase 5)" below for the per-mode split
and `SheetsAmbiguousWriteError`.

## Timeout rationale

`sheets_inspect`, `sheets_read`, and `sheets_write` (Phase 5) all set
`ToolSpec.timeoutMs: 30_000` (`packages/agent`) — a real Sheets API round
trip, including this client's own internal retries, can legitimately take
longer than the 10s default meant for local computation. The client's own
per-request timeout (`REQUEST_TIMEOUT_MS`, 10s) is independent and smaller —
it bounds one HTTP attempt, not the whole handler call.

## Tools

- `sheets_inspect { sheet }` — resolves the slug, fetches spreadsheet
  metadata, returns each tab's name, dimensions, and header row.
- `sheets_read { sheet, range, valueRenderOption? }` — resolves the slug
  (any `access` value permits a read; only `sheets_write`, Phase 5, checks
  `access`), fetches values. `valueRenderOption` defaults to
  `FORMATTED_VALUE` — the agent relays results to a human, so values as a
  human would see them (settled decision 16). Results are bounded by
  `truncate.ts`'s shared `truncateBySize` — see "Bounded results" below.
- `sheets_write { mode: "append" | "update", sheet, range, values,
  valueInputOption? }` (Phase 5) — the one write tool; see its own section
  below for the full design (access enforcement, dedupe/audit, the per-mode
  ambiguous-write split).

All three are the *base*, ungated `ToolSpec` — `apps/hermes/src/agent/
build-agent.ts` wraps each in `withRequiredScopes(name, { googleAccountRepo,
requiredScopes })`, the same split `whoami` uses: the capability lives in
this package, the scope gate lives in `apps/hermes`. `requiredScopes` for
each tool is read from `@hermes/google-auth`'s `TOOL_REQUIRED_SCOPES` map
(currently `SHEETS_SCOPES` for all three) rather than hardcoded at the wiring
site, so a tool's scope requirement is declared once. None of the three
tools checks scopes itself, and none calls the Sheets API (or even fetches
an access token) for an unconnected or under-scoped account — the gate runs
first and short-circuits before this package's handler is ever invoked.

## Bounded results — `truncate.ts`

`truncate.ts`'s `truncateBySize<T>(items, measure, caps?)` is a pure,
Sheets-agnostic helper shared by `sheets_read` (this phase), `sheets_inspect`
(Phase 2), and the update-mode `replaced` snapshot (Phase 7) — a huge range,
a many-tab spreadsheet, or a huge overwritten range can no longer dominate
model context. Two package-internal, non-env-configurable caps:
`MAX_CELLS = 500`, `MAX_VALUE_CHARS = 4_000`. It walks `items` in order,
accumulating both running totals via the caller's `measure`, and stops
*before* a would-be-added item would push either total over its cap —
**except the first item is always kept**, so a single oversized row/tab is
still returned whole, never split.

`sheets_read` calls it over `result.values` (measuring each row's cell count
and its `JSON.stringify` length) and returns results **additively**: an
untruncated read is byte-identical to today (no new keys at all). A
truncated read adds `truncated: true, returnedRows, totalRows, totalColumns,
note` alongside the (now-shorter) `values`. `totalRows` is `(result.values ??
[]).length` — the count Google's `values.get` actually returned for this
range, **not** the requested range's nominal size (`values.get` only returns
rows with data — `A1:Z1000` against a 40-row sheet returns 40 rows, not 1000
padded with empties). `totalColumns` is computed from the original,
pre-truncation `values`, not the truncated slice. `note` is Spanish, since
it's model-facing text the model typically relays to the same
Spanish-speaking user, consistent with this plan's other language decisions.

`sheets_inspect` calls the same helper over its tab summaries (measuring
each tab's `headerRow.length` and its `JSON.stringify` length) — **tab
granularity**, not `sheets_read`'s row granularity, so a many-tab (or
wide-header) spreadsheet can't dominate model context either. Results are
additive the same way: an untruncated inspect is byte-identical to today. A
truncated inspect adds `truncated: true, returnedTabs, totalTabs, note`
alongside the (now-shorter) `tabs`, with wording distinct from `sheets_read`'s
note (tabs vs. rows) so the model doesn't conflate the two in its reply. As
with `sheets_read`, a single oversized tab (e.g. a very wide header row) is
still returned whole rather than dropped, since `truncateBySize` always keeps
the first item.

## `sheets_write` (Phase 5)

`sheets_write { mode: "append" | "update", sheet, range, values,
valueInputOption? }` — `requiresApproval: true`, so every call routes
through `apps/hermes`'s `ApprovalGate` before this package's handler ever
runs.

**`prepare`/`plan` split (`06-legible-approvals-bounded-reads` Phases 3-4):**
`createSheetsWriteTool`'s `prepare` (`prepareWrite`) is the only step of the
write pipeline that runs *before* a human ever sees the approval prompt: it
resolves the slug (`resolveSheet`, moved out of the handler) and, for a known,
`readwrite`-access slug, returns `{ok: true, plan: SheetsWritePlan, summary}`
— `SheetsWritePlan { sheetSlug, spreadsheetId, effectiveValueInputOption }`
threads onto `ctx.plan` for the handler (no `access` field — by the time a
plan exists, the sheet is provably `readwrite`), and `summary` (`{action:
"¿Escribir en <slug>?", target: entry.description || undefined, effects:
[]}`) is what the approval prompt actually renders (`apps/hermes`'s generic,
tool-agnostic `ApprovalSummary` renderer — see `packages/agent/README.md`'s
"The `prepare` hook"). Both of `resolveSheet`'s failure modes refuse the call
*before* any prompt is sent, with their shapes unchanged: an unknown slug
returns `{ok: false, result: resolved}` (`unknown_sheet`), and — as of Phase
4 — a `read`-access sheet returns `{ok: false, result: {ok: false, reason:
"read_only_sheet"}}` right after slug resolution, closing the "asked to
approve a write already destined to fail" gap Phase 3 deliberately left open
for read-only sheets. The handler then reads `ctx.plan` instead of
re-resolving or re-checking access: it never calls `resolveSheet` a second
time and never recomputes `overrideOption ?? entry.valueInputOption` itself
(`sheets-write.test.ts` asserts the registry is queried exactly once per
call, not twice), and its own inline `access !== "readwrite"` check (Phase 3)
has been deleted as dead code — `prepare` is the only path that can reach the
handler, and it never does so with a disallowed sheet.

**Known gap, deliberately deferred (Tier 2):** the prompt's `target` line
names the sheet by its registry description (or the slug, when the
description is empty) but does not yet show a before/after diff or column
headers as row labels — that needs a pre-approval Google API read, deferred
to later work (see `plans/06-legible-approvals-bounded-reads.md`'s Context).
Tracked in `.ai/decisions/approval-gate-design.md`.

**The args schema is a flat `z.object`, not a `z.discriminatedUnion("mode",
…)`.** A root-level union converts to a top-level `anyOf` with no
`type: "object"`, which DeepSeek's OpenAI-compatible API rejects with HTTP 400
— and since every tool's schema ships on every completion request, that one
schema broke *every* turn, reads included. Regressed for all registered tools
by `apps/hermes/src/agent/__tests__/tool-schemas.test.ts`; see
`.ai/decisions/tool-arg-schema-top-level-object.md`.

**Order is load-bearing**, split across `prepare` and the handler: `prepare`
resolves the slug (unknown ⇒ the same `resolveSheet` short-circuit
`sheets_inspect`/`sheets_read` use) then **enforces `access === "readwrite"`**
(`{ok: false, reason: "read_only_sheet"}` otherwise) — both refusals happen
*before* the approval prompt is ever sent (Phase 4). Only once `prepare`
has produced a plan does the handler run: **claim the dedupe key** → resolve
`valueInputOption` → fetch an access token → call the Sheets API. Neither
gate ever touches `sheet_write_log` or the Sheets client, and a `read`-access
refusal never reaches a human at all.

**Dedupe/audit**: `canonical-args.ts`'s `computeDedupeKey` hashes `(channel,
channelUserId, turnId, tool, canonicalized args)` — `sha256`, mirroring
`llm-dedupe-repo`'s claim/complete shape — and `SheetWriteLogPort` (declared
in `tools/sheets-write.ts`, the consumer-declares-its-port convention again)
claims it against `@hermes/store`'s `sheet_write_log` table (`apps/hermes/
src/boot.ts` binds it inline over `claimSheetWrite`/`completeSheetWrite`, the
same shape `llm_dedupe`'s `dedupeRepo` already uses). `turnId` is part of the
key **on purpose**, not incidentally: a same-turn model retry with identical
args short-circuits on the claim (the Sheets API is never called a second
time, and the stored outcome is returned instead); a later, genuinely
repeated user request — a different `turnId` — is allowed to proceed and
write again. This table is also this plan's durable write audit for
invariant 3: `telemetry_events` is buffered and at-most-once, so it can't be
the audit of record for a mutation; claim-before-call plus a stored outcome
can.

A claim can also come back `{alreadyPending: true}` — the claim-to-complete
crash window (`packages/store/README.md`): `complete()` never landed for a
prior attempt at this exact key, so it's unknown whether that attempt's
write actually reached Google. This is **not** fail-open: the handler never
calls the Sheets API in this case, returning the same structured
`{ok: false, reason: "ambiguous_write", ...}` hedge a post-send-ambiguous
`appendValues` failure gets, without recording it via `complete()` (this
call didn't originate the write, so it must not overwrite whatever the
owning attempt eventually records).

**Per-mode retryable-vs-ambiguous split** (settled decision 15) —
`sheets-client.ts`'s `appendValues`/`updateValues` both retry a **pre-send**
failure (429, or a connection refused before the request ever left) freely,
the same posture the read client takes. A **post-send** failure (this
client's own timeout firing, or any 5xx — necessarily received after the
request reached Google) is where the two modes diverge, because `POST
:append` and `PUT` (fixed range) have different idempotency:

- `updateValues` — a fixed-range `PUT` converges to the same end state
  whether or not the first attempt landed, so a post-send-ambiguous failure
  is retried **once, internally**, with the identical `range`/`values` (the
  same `attempt` closure, not a second call). If that retry still fails, the
  original error (never a `SheetsAmbiguousWriteError` — that type is only
  ever thrown by `appendValues`) propagates out of `updateValues` as a
  genuine fatal error.
- `appendValues` — not idempotent (a resend of an already-applied append
  doubles the row), so a post-send-ambiguous failure throws
  `SheetsAmbiguousWriteError` immediately, **never retried** by the client.

Both branches of `sheets-write.ts`'s handler call the Sheets API through the
same shared `performWrite` helper, so both get the same error handling:
`performWrite` catches `SheetsAmbiguousWriteError` (which, per above, only
`mode: "append"` can ever throw) and returns a structured `{ok: false,
reason: "ambiguous_write", message}` — "may or may not have landed, check
the sheet" — recording it via `complete` the same as any other outcome, so a
same-turn duplicate claim returns the same hedge without a second API call.

**Definitive-failure claim release**: a fatal `SheetsApiError` reaching
`performWrite`'s catch block, for **either** mode (a non-429 4xx, thrown
immediately by `classifyWrite` — Google rejected the request outright — or
an exhausted 429, thrown after retries — Google never got past quota
enforcement to apply it) is provably **not** ambiguous: the sheet was never
mutated. That branch calls `sheetWriteLogRepo.release` (optional on
`SheetWriteLogPort`; `@hermes/store`'s `releaseSheetWrite`, `apps/hermes/src/
boot.ts`-wired) to delete the still-`pending` row before rethrowing, so a
legitimate same-turn retry isn't blocked by `alreadyPending`'s hedge over a
write that definitely never landed. Any other error (a network failure that
can't be proven pre-send, a malformed response body after a 2xx, ...) keeps
the pending row — the fail-safe default stays "when in doubt, hedge." This
release logic is identical for `mode: "update"`: a definitive `SheetsApiError`
(a 4xx, or an exhausted 429) releases the claim the same way, closing what
was previously an append/update asymmetry (code review, `05-google-sheets`
close-out) that could leave an `update`'s claim stuck `pending` — and a
same-turn retry falsely told the write was ambiguous — after a write that
provably never landed.

**`valueInputOption` stakes** (settled decision 17): `USER_ENTERED` parses
cell content the way a human typing it would (real dates/numbers land
correctly, but e.g. a phone number like `+1-555-0100` can misparse as a
formula, and a leading zero like `0123` is dropped); `RAW` stores literally
(safe for phone numbers/IDs, but a date lands as a text string, breaking any
`SUM`/sort/chart already built over that column). The registry row's
`value_input_option` is the per-sheet default; the tool arg's
`valueInputOption`, when given, overrides it for that one call.

## Dependencies

`@hermes/core`, `zod` — no `googleapis`, no new third-party HTTP client
(settled decision 20). Deliberately not `@hermes/store` or
`@hermes/google-auth` (both ports above are injected) — this package's
type-only reference to `@hermes/agent`'s `ToolSpec` shape is avoided
entirely: the tools here return a plain object structurally compatible with
`ToolSpec`, and `apps/hermes` (which does depend on `@hermes/agent`) is
where that structural match is actually type-checked against the real type.
