# @hermes/google-gmail

The generic Gmail capability: read (and, in a later phase, send) mail on the
connected account. Nothing trading-specific lives here — see
`plans/09-gmail-read-then-send.md`'s Context. Phase 1 ships
`gmail_list_unread` (read-only) alongside the package scaffold itself. Phase
2 ships `gmail_search` and `gmail_read_thread` — the first tools that put
actual mail body text into context, bounded (see "Body pipeline" below).

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
  headers, label ids and `snippet` only, no body. Phase 1 shipped zero MIME
  parsing code; Phase 2 adds it (see "Body pipeline" below) via two more
  methods:
- `getMessageFull(accessToken, id, signal?)` — `GET /users/me/messages/
  {id}?format=full`, the full MIME `payload` (recursively, with each part's
  own `body.data`) for one message. `gmail_read_thread` calls this only for
  the messages its per-thread cap actually keeps, never for every message in
  a large thread.
- `getThread(accessToken, threadId, signal?)` — `GET /users/me/threads/
  {id}?format=full`. `gmail_read_thread` reads only `id`/`internalDate` off
  each returned message stub (enough to sort newest-first and cap the
  count) — the per-message body is fetched separately, only for the capped
  subset, via `getMessageFull`.

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

`gmail_list_unread`/`gmail_search`/`gmail_read_thread` all set
`ToolSpec.timeoutMs: 30_000` (`packages/agent`) — a real Gmail API round
trip (a list/thread call plus one metadata/full fetch per returned
message), including this client's own internal retries, can legitimately
take longer than the 10s default meant for local computation.
`gmail_read_thread` is the one most likely to press this budget — it fans
out over several `getMessageFull` calls, which is exactly why the
per-thread cap is applied *before* issuing them (see "Body pipeline"
below), not after. The client's own per-request timeout
(`REQUEST_TIMEOUT_MS`, 10s) is independent and smaller — it bounds one HTTP
attempt, not the whole handler call.

## Body pipeline (Phase 2)

`gmail_read_thread` extracts each kept message's readable text as four
separately-testable pure functions, composed in the tool handler rather
than one `parseMessage` blob — order is load-bearing:

1. `mime.ts`'s `decodePart(part)` — base64url-decodes `body.data`, then
   `decodeQuotedPrintable` when the part's own `Content-Transfer-Encoding`
   says so, then `decodePartText` (charset-aware, off the part's own
   `Content-Type`). `decodePartText` **never throws** on a malformed or
   unrecognized `charset=` — it falls back to UTF-8.
2. `html-to-text.ts`'s `htmlToText(html)` — only when `findBodyPart` picked
   an HTML part. Strips `<script>`/`<style>` wholesale, block tags become
   newlines, entities decode, 3+ blank lines collapse to one.
3. `strip-quoted-reply.ts`'s `stripQuotedReply(text)` — cuts at the first
   quote boundary (an "On … wrote:"/"El … escribió:" attribution line, a run
   of `>`-prefixed lines, a `-----Original Message-----` separator, or a
   `--` signature separator). **Always returns at least the first non-empty
   paragraph** — a false-positive boundary that would eat the whole message
   falls back to the original text's first paragraph instead of returning
   `""`.
4. A per-message char cap (`MAX_BODY_CHARS_PER_MESSAGE = 2_000`,
   `truncate.ts`) — applied **after** steps 2-3, never on raw HTML: capping
   before HTML→text would spend the whole budget on markup. A message cut
   this way carries `bodyTruncated: true`.

`findBodyPart` (`mime.ts`) recursively prefers `text/plain` over `text/html`
at every level of a `multipart/*` tree, falling back to the deepest
`text/html` when no plain part exists anywhere, and returns `undefined` for
an attachment-only payload — in which case the message's `text` is `""`,
never a thrown error.

**Per-thread bound, applied before any body is fetched.** `gmail_read_thread`
sorts a thread's message refs newest-first, then runs `truncate.ts`'s
Gmail-local `truncateBySize` over them (`MAX_THREAD_MESSAGES = 10`,
`measureMessage(0)` — a message-count-only cap at this stage, since no body
has been fetched yet) to decide which messages to keep. Only the kept
messages are fetched via `getMessageFull` and run through the body pipeline
above — a 100-message thread issues at most 10 `getMessageFull` calls, not
100. `truncateBySize` mirrors `packages/google-sheets/src/truncate.ts`'s
contract exactly (accumulate in order, stop before exceeding a cap, always
keep at least one item) — deliberately **not** promoted to `@hermes/core`;
see `.ai/decisions/bounded-tool-results.md`'s third-caller trigger.

## Tools

- `gmail_list_unread { maxResults? }` — lists unread inbox messages
  (`labelIds: ["UNREAD", "INBOX"]`), fetches metadata for each, and returns
  `{ ok: true, messages: [{ id, threadId, from, subject, date, unread,
  important }] }`. `maxResults` defaults to 10, capped at 25 — no pagination
  this phase. An empty inbox returns `{ ok: true, messages: [] }`, never an
  error. A `GmailApiError` with status 401/403 is caught and mapped via
  `toInsufficientScopeResult` to the structured refusal instead of
  propagating as a throw.
- `gmail_search { query, maxResults? }` — free-text search using Gmail's own
  `q` operator syntax (`from:`, `newer_than:`, `has:attachment`, …), passed
  to `listMessages` verbatim. Returns the same bounded metadata projection
  `gmail_list_unread` returns, plus each message's `snippet`. No body text —
  a match worth reading in full goes to `gmail_read_thread` next.
  `maxResults` defaults to 10, capped at 25. Same empty-result and
  `insufficient_scope` handling as `gmail_list_unread`.
- `gmail_read_thread { threadId }` — reads a thread's messages in full,
  newest first, per the body pipeline above. Returns `{ ok: true, threadId,
  subject, messages: [{ id, from, to, date, text, bodyTruncated? }],
  ...(truncated && { truncated: true, returnedMessages, totalMessages,
  note }) }`. The truncation fields are **additive via conditional spread**
  — an untruncated thread's result is byte-identical to the un-capped shape,
  no new keys (`.ai/decisions/bounded-tool-results.md`). `note` is Spanish
  and only states what was omitted (the tool takes no offset argument, so it
  never invites the model to ask for "the rest"). A thread with no readable
  text part in a kept message returns that message with `text: ""`, never a
  thrown error.

All three are base, ungated `ToolSpec`s — `apps/hermes/src/agent/
build-agent.ts` wraps each in `withRequiredScopes(name, { googleAccountRepo,
requiredScopes })`, the same split `whoami`/the Sheets/Calendar tools use:
the capability lives in this package, the scope gate lives in
`apps/hermes`. `requiredScopes` is read from `@hermes/google-auth`'s
`TOOL_REQUIRED_SCOPES` map (`GMAIL_READ_SCOPES` for all three) rather than
hardcoded at the wiring site. No tool here checks scopes itself and none
calls the Gmail API (or even fetches an access token) for an unconnected or
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
