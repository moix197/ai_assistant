# @hermes/google-gmail

The generic Gmail capability: read (and, in a later phase, send) mail on the
connected account. Nothing trading-specific lives here — see
`plans/09-gmail-read-then-send.md`'s Context. Phase 1 ships
`gmail_list_unread` (read-only) alongside the package scaffold itself.

## Ports

One consumer-declared port, following `@hermes/google-auth`'s
`GoogleAccountRepo` convention — this package never imports `@hermes/store`
or `@hermes/google-auth` directly:

- `AccessTokenPort { getAccessToken(channel, channelUserId): Promise<string> }`
  (`access-token-port.ts`) — bound in `apps/hermes/src/google/
  build-access-token-port.ts` over `@hermes/google-auth`'s
  `RefreshCoordinator.getValidAccessToken`, the same refresh seam
  `@hermes/google-sheets` and `@hermes/google-calendar` bind to (settled
  decision 18). Unlike Calendar, Gmail needed no package-specific binder
  file: `build-access-token-port.ts`'s `buildAccessTokenPort` was
  generalized (it no longer imports Sheets' own `AccessTokenPort` type) and
  is reused directly, since every consumer's port is structurally identical.

## No registry — two ports, not three

`GmailToolDeps { accessTokenPort; gmailClient }` mirrors
`@hermes/google-calendar`'s `CalendarToolDeps` exactly — there is no
`SheetRegistryPort`-style third port, because there is no reach-gate to
enforce (settled decision 7). A connected, sufficiently-scoped account can
read its own inbox outright.

## `gmail-client.ts`

A thin `fetch`-based client over the Gmail v1 REST API, built on
`@hermes/core`'s `withHttpRetry` — no `googleapis`, no new third-party HTTP
client (settled decision 20, same posture as `sheets-client.ts`/
`calendar-client.ts`). Two read methods this phase:

- `listMessages(accessToken, { q?, labelIds? }, maxResults, signal?)` —
  `GET /users/me/messages?q=...&labelIds=...&maxResults=...`. `q`/`labelIds`
  are bundled into one params object rather than positional args so a later
  phase's free-text search (`gmail_search`) can supply `q` without a new
  client method. Returns `messages: []` (never `undefined`) when the API
  response omits the field — an empty inbox is not an error.
- `getMessageMetadata(accessToken, id, signal?)` — `GET /users/me/messages/
  {id}?format=metadata&metadataHeaders=From&metadataHeaders=To&
  metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID` —
  headers and label ids only, no body, so this phase ships zero MIME parsing
  code.

Own `classify` (429 → `rateLimit`, honoring `Retry-After`; 5xx →
`transient`; anything else — **notably 401/403** — fatal, thrown directly,
never retried) and own `redact` (strips the bearer token from any thrown
message) — `withHttpRetry` itself never touches request/response content,
per its own contract. Both methods are reads (`GET`), naturally idempotent,
so both retry classes retry freely within the tool's own timeout budget —
no `sheets-client.ts`-style ambiguous-write split is needed here (there is
no write this phase).

## `insufficient-scope.ts`

`toInsufficientScopeResult(error, scope, fix)` maps a caught `GmailApiError`
with status 401 or 403 to `{ ok: false, reason: "insufficient_scope", scope,
fix }` — the **same field shape** `apps/hermes/src/agent/
with-required-scopes.ts`'s `withRequiredScopes` returns for its pre-call
`missing_scope` gate, so the model has one refusal vocabulary regardless of
which check caught it. Returns `undefined` for any other error so the
caller rethrows it as a genuine fatal error. `scope`/`fix` are supplied by
the caller (hardcoded per-tool, e.g. `gmail-list-unread.ts`'s
`GMAIL_READ_SCOPE`/`GMAIL_READ_FIX`) rather than looked up from
`@hermes/google-auth`, since this package never imports it. Defense in
depth: `withRequiredScopes` already gates every call on a granted scope
before the handler runs, but a scope revoked at Google *after* that
pre-check still needs a structured refusal, not a throw. Shared by every
Gmail tool from here on.

## Timeout rationale

`gmail_list_unread` sets `ToolSpec.timeoutMs: 30_000` (`packages/agent`) —
a real Gmail API round trip (one list call plus one metadata fetch per
returned message), including this client's own internal retries, can
legitimately take longer than the 10s default meant for local computation.
The client's own per-request timeout (`REQUEST_TIMEOUT_MS`, 10s) is
independent and smaller — it bounds one HTTP attempt, not the whole handler
call.

## Tools

- `gmail_list_unread { maxResults? }` — lists unread inbox messages
  (`labelIds: ["UNREAD", "INBOX"]`), fetches metadata for each, and returns
  `{ ok: true, messages: [{ id, threadId, from, subject, date, unread,
  important }] }`. `maxResults` defaults to 10, capped at 25 — no pagination
  this phase. An empty inbox returns `{ ok: true, messages: [] }`, never an
  error. A `GmailApiError` with status 401/403 is caught and mapped via
  `toInsufficientScopeResult` to the structured refusal instead of
  propagating as a throw.

The base, ungated `ToolSpec` — `apps/hermes/src/agent/build-agent.ts` wraps
it in `withRequiredScopes("gmail_list_unread", { googleAccountRepo,
requiredScopes })`, the same split `whoami`/the Sheets/Calendar tools use:
the capability lives in this package, the scope gate lives in
`apps/hermes`. `requiredScopes` is read from `@hermes/google-auth`'s
`TOOL_REQUIRED_SCOPES` map (`GMAIL_READ_SCOPES`) rather than hardcoded at
the wiring site. The tool never checks scopes itself and never calls the
Gmail API (or even fetches an access token) for an unconnected or
under-scoped account — the gate runs first and short-circuits before this
package's handler is ever invoked.

## Dependencies

`@hermes/core`, `zod` — no `googleapis`, no new third-party HTTP client
(settled decision 20). Deliberately not `@hermes/store` or
`@hermes/google-auth` (the one port above is injected) — this package's
type-only reference to `@hermes/agent`'s `ToolSpec` shape is avoided
entirely: the tool here returns a plain object structurally compatible with
`ToolSpec`, and `apps/hermes` (which does depend on `@hermes/agent`) is
where that structural match is actually type-checked against the real type.
