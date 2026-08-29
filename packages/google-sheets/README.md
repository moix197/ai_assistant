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

- `getSpreadsheetMeta(accessToken, spreadsheetId, signal?)` — `GET
  /v4/spreadsheets/{spreadsheetId}?fields=sheets.properties,sheets.data.rowData.values.formattedValue`,
  a `fields` mask rather than the unbounded default response. Backs
  `sheets_inspect`.
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

## Timeout rationale

Both `sheets_inspect` and `sheets_read` set `ToolSpec.timeoutMs: 30_000`
(`packages/agent`, Phase 4) — a real Sheets API round trip, including this
client's own internal retries, can legitimately take longer than the 10s
default meant for local computation. The client's own per-request timeout
(`REQUEST_TIMEOUT_MS`, 10s) is independent and smaller — it bounds one HTTP
attempt, not the whole handler call.

## Tools

- `sheets_inspect { sheet }` — resolves the slug, fetches spreadsheet
  metadata, returns each tab's name, dimensions, and header row.
- `sheets_read { sheet, range, valueRenderOption? }` — resolves the slug
  (any `access` value permits a read; only `sheets_write`, Phase 5, checks
  `access`), fetches values. `valueRenderOption` defaults to
  `FORMATTED_VALUE` — the agent relays results to a human, so values as a
  human would see them (settled decision 16).

Both are the *base*, ungated `ToolSpec` — `apps/hermes/src/agent/
build-agent.ts` wraps each in `withRequiredScopes(name, { googleAccountRepo,
requiredScopes: SHEETS_SCOPES })`, the same split `whoami` uses: the
capability lives in this package, the scope gate lives in `apps/hermes`.
Neither tool checks scopes itself, and neither calls the Sheets API (or even
fetches an access token) for an unconnected or under-scoped account — the
gate runs first and short-circuits before this package's handler is ever
invoked.

## What Phase 5 adds

`sheets_write` (`requiresApproval: true`): access enforcement
(`read`-access sheets refused before any API call), a claim/complete
idempotency key over `(channel, channelUserId, turnId, tool, canonical
args)` guarding against a same-turn retry double-applying a write, and a
per-mode retryable-vs-ambiguous split for `appendValues`/`updateValues` —
see `plans/05-google-sheets.md`'s Phase 5 for the full design.

## Dependencies

`@hermes/core`, `zod` — no `googleapis`, no new third-party HTTP client
(settled decision 20). Deliberately not `@hermes/store` or
`@hermes/google-auth` (both ports above are injected) — this package's
type-only reference to `@hermes/agent`'s `ToolSpec` shape is avoided
entirely: the tools here return a plain object structurally compatible with
`ToolSpec`, and `apps/hermes` (which does depend on `@hermes/agent`) is
where that structural match is actually type-checked against the real type.
