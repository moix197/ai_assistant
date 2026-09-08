# @hermes/google-gmail

The generic Gmail capability: read and send mail on the connected account.
Nothing trading-specific lives here — see `plans/09-gmail-read-then-send.md`'s
Context. Phase 1 ships `gmail_list_unread` (read-only) alongside the package
scaffold itself. Phase 2 ships `gmail_search` and `gmail_read_thread` — the
first tools that put actual mail body text into context, bounded (see "Body
pipeline" below). Phase 3 ships the write tier's first two tools,
`gmail_archive` and `gmail_label` — both approval-gated, both reversible,
proving the whole `prepare` → `ApprovalSummary` → Telegram prompt → tap →
handler → Gmail path before Phase 5's irreversible `gmail_send_draft` ever
exists. Phase 4 ships `gmail_draft_reply` — a real, threaded Gmail draft the
human reads in full before it exists, still reversible (a draft, never a
send) but the first tool to compose its own outbound MIME content. Phase 5
ships `gmail_send_draft` — the one irreversible tool in this package, backed
by a durable `gmail_send_log` claim/complete/release dance
(`@hermes/store`'s `gmail-send-log-repo.ts`) rather than the reversible
tools' no-log posture (see "No durable write log" below, and its own section
further down).

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

Phase 3 adds the first write method, plus one more read:

- `modifyMessage(accessToken, id, { addLabelIds?, removeLabelIds? }, signal?)`
  — `POST /users/me/messages/{id}/modify` (`users.messages.modify`). Backs
  `gmail_archive` (`removeLabelIds: ["INBOX"]`) and `gmail_label`
  (`addLabelIds`/`removeLabelIds: [resolvedLabelId]`). **Idempotent by
  Gmail's own label semantics** — adding an already-present label or
  removing an already-absent one is a harmless no-op — so it goes through
  the same `requestWithRetry` path and the same retry classes every `GET`
  does; no `sheets-client.ts`-style ambiguous-write split is needed.
- `listLabels(accessToken, signal?)` — `GET /users/me/labels`
  (`users.labels.list`). Backs `gmail_label`'s label-name-to-id resolution,
  so `prepare` can refuse an unknown label legibly, before any approval
  prompt, listing every registered label.

Phase 4 adds the draft methods, plus `PUT` support in the shared
request/retry path (`requestJson`/`requestWithRetry` now take an optional
`method`, defaulting to `POST`/`GET` off `body`'s presence when omitted — no
existing call site changes):

- `createDraft(accessToken, { threadId, raw }, signal?)` — `POST
  /users/me/drafts` (`users.drafts.create`). Backs `gmail_draft_reply`'s
  create path.
- `updateDraft(accessToken, draftId, { threadId, raw }, signal?)` — `PUT
  /users/me/drafts/{draftId}` (`users.drafts.update`), the one `PUT` call
  this client makes. Backs `gmail_draft_reply`'s update path — same draft id
  in, same draft id out.
- `getDraft(accessToken, draftId, signal?)` — `GET /users/me/drafts/{draftId}`
  (`users.drafts.get`). Not called by `gmail_draft_reply`; backs Phase 5's
  `gmail_send_draft` existence check before sending.

Own `classify` (429 → `rateLimit`, honoring `Retry-After`; 5xx →
`transient`; anything else — **notably 401/403** — fatal, thrown directly,
never retried) and own `redact` (strips the bearer token from any thrown
message) — `withHttpRetry` itself never touches request/response content,
per its own contract. Every `GET` this client makes is naturally idempotent,
and the one `POST` (`modifyMessage`) is idempotent by Gmail's own semantics
too, so both retry freely within the tool's own timeout budget with no
method-specific special-casing.

Phase 5 adds the one irreversible call:

- `sendDraft(accessToken, draftId, signal?)` — `POST /users/me/drafts/send`
  (`users.drafts.send`). Sends `draftId` as-is and deletes the draft
  resource; Google returns the resulting **sent message**
  (`GmailSendResult { id, threadId }`), never the now-gone draft. Backed by
  its own `classifySend` (a package-local mirror of
  `packages/google-sheets/src/sheets-client.ts`'s `classifyWrite`, not
  reused across packages for the same reason `truncate.ts`/
  `canonical-args.ts` aren't): a 429 is safe to retry (rejected before
  applying); a network failure provably pre-send (`ECONNREFUSED`/
  `ENOTFOUND`/`EAI_AGAIN`, via `isPreSendNetworkFailure`) retries too; **any**
  other failure — a 5xx after the request left, this client's own timeout
  abort, or an unrecognized network error that cannot be proven pre-send —
  is `postSendAmbiguous` and is **never retried** (`maxAttempts: 0`), instead
  throwing `GmailAmbiguousSendError` on the very first such failure. A
  non-429 4xx (rejected outright) or an exhausted 429 throws the underlying
  `GmailApiError` directly, never wrapped — `gmail-send-draft.ts`'s handler
  distinguishes the two by type: a `GmailApiError` means the send provably
  never landed (release the pending claim); a `GmailAmbiguousSendError`
  means it might have (keep the claim, hedge instead of retrying — the
  recovery for a false "it failed" is a duplicate email to a real human).

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

## `build-mime-message.ts` (Phase 4)

Our own, narrow RFC 2822 composer — no library, same posture as
`gmail-client.ts`'s own fetch wrapper and `mime.ts`'s own parser.
`buildMimeMessage({ from, to, subject, body, inReplyTo?, references? })`
returns the base64url-encoded raw message Gmail's `drafts.create`/
`drafts.update` `raw` field requires:

- `Subject` goes through RFC 2047 encoding (`=?UTF-8?B?<base64>?=`)
  **whenever it contains non-ASCII** — the default case for Spanish accented
  text, not an edge case. An ASCII subject passes through unencoded.
- The body is `Content-Type: text/plain; charset="UTF-8"` with
  `Content-Transfer-Encoding: base64`, base64-encoded as UTF-8 bytes and
  wrapped at 76 characters per line — CRLF throughout, matching RFC 2045's
  recommended line length for encoded content.
- **Header injection defense**: every header value passes through
  `sanitizeHeaderValue`, which collapses any `\r`/`\n` to a space before the
  value is ever written — a subject or body containing a raw CRLF can never
  terminate a header line early and inject a new one (e.g. a smuggled
  `Bcc:`). The body is doubly safe: it is always base64-encoded, so even an
  unsanitized newline inside it would only ever become harmless base64
  alphabet bytes, never a literal line break in the raw message.
- `In-Reply-To`/`References` are written only when supplied — a first
  message in a thread carries neither.

`buildMimeMessage` is called exactly once per `gmail_draft_reply` call,
**inside `prepare`**, never in the handler — see the tool's own section
below for why that's the phase's load-bearing safety property.

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

- `gmail_archive { threadId }` — approval-gated (`requiresApproval: true`).
  `prepare` resolves the thread's newest message (subject for the prompt, id
  for the handler) and builds a Spanish summary: `"¿Archivar esta
  conversación?"`, target the subject, effects `["Sale de Recibidos. Sigue
  disponible en Todos los mensajes."]`. A thread id Gmail 404s on refuses
  **before** any prompt with `{ ok: false, reason: "thread_not_found" }`.
  `handler` reads `ctx.plan` and removes `INBOX` via `modifyMessage` — it
  never re-resolves the thread. Returns `{ ok: true, threadId, subject }`.
- `gmail_label { threadId, label, action? }` — approval-gated. A **flat
  object plus enum** schema, never a root union
  (`.ai/decisions/tool-arg-schema-top-level-object.md`) — `action` is
  `"add"` (default) or `"remove"`. `prepare` resolves `label` (a display
  name) to its id via `listLabels`, refusing an unknown name **before** any
  prompt with `{ ok: false, reason: "unknown_label", available: [...] }` —
  the shape `resolve-sheet.ts`'s `unknown_sheet` established — and resolves
  the thread's newest message the same way `gmail_archive` does, refusing
  `thread_not_found` the same way. `handler` reads `ctx.plan` and calls
  `modifyMessage` with the resolved label id on the planned side
  (`addLabelIds` or `removeLabelIds`) — it never re-resolves the label name
  or re-lists labels. Returns `{ ok: true, threadId, label, action }`.

Both write tools' `prepare` and `handler` catch a 401/403 the same way every
read tool's handler does — via `toInsufficientScopeResult` — since a scope
revoked at Google after `withRequiredScopes`'s pre-check can still surface
mid-call.

**No durable write log, unlike `gmail_send_draft` (Phase 5).** Because
`modifyMessage` is genuinely idempotent — re-archiving an already-archived
thread, or re-adding an already-present label, is a harmless no-op — a
crashed process or an ambiguous response is safe to retry outright. There is
no `SheetWriteLogPort`-style claim/complete dance here; see Phase 6's
`.ai/decisions/gmail-send-intent-log.md` for why `gmail_send_draft`, the one
*irreversible* tool, needs one and these two don't.

- `gmail_draft_reply { threadId, body, draftId? }` — approval-gated. A
  present `draftId` updates that draft; an absent one creates a new one.
  `prepare` reads the thread's newest message's headers (`getThread` +
  `getMessageMetadata`, the same call pair `gmail_archive`/`gmail_label`
  make) to derive the reply's recipient (the newest message's `From`), our
  own address (the newest message's `To`), the `Re:`-prefixed subject (never
  double-prefixed if the original already starts with "Re:") and the
  `In-Reply-To`/`References` threading headers (both set to the newest
  message's `Message-ID` — this tool has no fuller reference chain to
  thread). **`prepare` composes the full `raw` MIME message right there**,
  via `build-mime-message.ts`'s `buildMimeMessage`, and threads it onto
  `plan.raw` — `handler` posts it verbatim, never recomposing anything, so
  the bytes a human approved are structurally the bytes Gmail saves
  (`.ai/decisions/tool-prepare-hook.md`). The approval summary shows
  `"¿Guardar este borrador de respuesta?"` (create) or `"¿Actualizar el
  borrador?"` (update), target `"Para: <to> — <subject>"`, the
  whitespace-collapsed, length-capped body as `items`, and effects
  `["Se guarda como borrador en Gmail. No se envía nada todavía."]` — the
  body preview renders through the existing generic `ApprovalSummary.items`
  mechanism, no renderer change. `handler` dispatches to `updateDraft`
  (`draftId` present) or `createDraft` (absent) — never both, never
  neither — and returns `{ ok: true, draftId, to, subject, body }`; a
  following turn (e.g. "cambiá el viernes por el lunes") passes that
  `draftId` back in to update the same draft, with no new inbound-reply-
  correlation machinery. A thread id Gmail 404s on refuses before any
  prompt with `thread_not_found`, same posture as `gmail_archive`/
  `gmail_label`. **This tool never calls, references, or wires up
  `drafts.send`/`messages.send` anywhere** — a draft is reversible, a send
  is Phase 5's problem.

## `gmail_send_draft` (Phase 5) — the one irreversible tool

`gmail_send_draft { draftId }` — approval-gated, `requiresApproval: true`,
backed by `@hermes/store`'s `gmail_send_log` (see that package's README for
the table's own shape) via an injected `GmailSendLogPort`
(`CreateGmailSendDraftToolDeps.sendLogRepo`, following the same
consumer-declares-its-port convention `SheetWriteLogPort` does) — the only
Gmail tool that carries one.

- **`prepare`** fetches the draft (`getDraft`) and refuses pre-prompt —
  **before any intent row is ever written** — with
  `{ ok: false, reason: "draft_not_found" }` if it no longer exists (already
  sent, deleted, or never existed). It then reads the draft's own
  `to`/`subject`/body preview via `getMessageFull` and the same
  `findBodyPart`/`decodePart`/`htmlToText` pipeline `gmail_read_thread` uses
  (minus `stripQuotedReply` — irrelevant for our own composed outbound
  draft), builds the summary (`"¿Enviar este correo?"`, target
  `"Para: <to> — <subject>"`, the body preview as `items`, effects
  `["Se envía de verdad. Esto no se puede deshacer."]`), and only *then*
  calls `sendLogRepo.recordIntent` — writing an `awaiting_approval` row. This
  is a deliberate divergence from `sheets_write`'s `prepare`, which claims
  nothing before approval: it is an **intent, never a claim and never a
  grant** — see `packages/store/README.md`'s "Gmail send log" section for the
  full three-state lifecycle and why Gmail needs this extra state and Sheets
  doesn't. A throw here (e.g. the database is unreachable) propagates out of
  `prepare`, which the generic `.ai/decisions/tool-prepare-hook.md` contract
  already turns into `{ ok: false, reason: "prepare_failed" }` with no prompt
  ever shown — fail-closed, no new mechanism needed.
- **`handler`** claims the same dedupe key `prepare` computed
  (`(channel, channelUserId, turnId, tool, { draftId })`, via this package's
  own `canonical-args.ts`) and resolves one of three ways, mirroring
  `sheets_write`'s dedupe exactly: `"claimed"` proceeds to call `sendDraft`;
  `alreadyComplete` returns the stored outcome with **zero** further Gmail
  calls (not even a token fetch); `alreadyPending` returns
  `{ ok: false, reason: "ambiguous_send", message: "puede que ya se haya
  enviado — revisá Enviados antes de reintentar" }` and writes nothing. On a
  successful send, `complete()` stores the **sent message id** (`sendDraft`
  deletes the draft it sends, so the id it returns is a message, not the
  gone draft) and the handler returns
  `{ ok: true, messageId, threadId, to, subject }`. The
  definitive-vs-ambiguous split mirrors `sheets-write.ts`'s `performWrite`:
  a caught `GmailAmbiguousSendError` records and returns the `ambiguous_send`
  hedge via `complete()` (the pending row is **never** released — a same-turn
  duplicate claim then returns that same hedge without a second Gmail call);
  a caught `GmailApiError` (only ever a non-429 4xx or an exhausted 429 per
  `classifySend`) releases the still-pending claim first, then either
  returns the structured `insufficient_scope` refusal (a 401/403) or
  rethrows as a genuine fatal error — never both. Any other thrown error
  propagates with the claim left pending, the fail-safe default.
- **Never a code path from a stored row to a send.** The `awaiting_approval`
  row `prepare` writes is read-only for reporting: `claim` only ever
  transitions a row *out of* that state (or inserts fresh), and nothing
  anywhere treats a row's presence, status, or content as authorization.
  `apps/hermes/src/agent/telegram-approval-gate.ts`'s optional
  `describeExpiredApproval` reads the log purely to answer a stale tap after
  a restart ("no se envió nada, el borrador sigue guardado…") — it never
  executes this tool, the client, or `claim`.

All seven gated/ungated tools are base `ToolSpec`s — `apps/hermes/src/agent/build-agent.ts` wraps
each in `withRequiredScopes(name, { googleAccountRepo, requiredScopes })`,
the same split `whoami`/the Sheets/Calendar tools use: the capability lives
in this package, the scope gate lives in `apps/hermes`. `requiredScopes` is
read from `@hermes/google-auth`'s `TOOL_REQUIRED_SCOPES` map
(`GMAIL_READ_SCOPES` for the three read tools; **`gmail.modify` only** — not
the whole `GMAIL_WRITE_SCOPES` tier — for `gmail_archive`/`gmail_label`/
`gmail_draft_reply`, so each tool's declared requirement stays the minimum
it actually needs; **`gmail.send` only** for `gmail_send_draft` — unlike
`gmail_draft_reply`, `drafts.send` is not covered by `gmail.modify` alone)
rather than hardcoded at the wiring site. `gmail_draft_reply`
adds no new connect-tier scope of its own: `drafts.create`/`drafts.update`
accept `gmail.modify` per Google's per-method scope table, so it rides the
write tier `/connect google gmail-send` already grants (Phase 3) — see the
plan's "This tool requires the write tier" note for why drafting, though
reversible, is gated exactly as hard as sending is reachable. No tool here
checks scopes itself and none calls the Gmail API (or even fetches an access
token) for an unconnected or under-scoped account — the gate runs first and
short-circuits before this package's handler (or `prepare`) is ever invoked.

## Two scope tiers (Phase 3)

`/connect google gmail` grants identity + `gmail.readonly` (Phase 1-2, the
three read tools). `/connect google gmail-send` grants identity +
`gmail.readonly` + `gmail.modify` + `gmail.send` — deliberately re-requesting
`gmail.readonly` even though `gmail.modify` functionally implies read, since
`hasRequiredScopes` (`@hermes/google-auth`) is literal string containment
with no implication table (settled decision 1; see the plan's Dependencies &
Risks for the named contingency if Google ever normalizes the combined
request down to one granted scope).

## Dependencies

`@hermes/core`, `zod` — no `googleapis`, no new third-party HTTP client
(settled decision 20). Deliberately not `@hermes/store` or
`@hermes/google-auth` (the one port above is injected) — this package's
type-only reference to `@hermes/agent`'s `ToolSpec` shape is avoided
entirely: the tool here returns a plain object structurally compatible with
`ToolSpec`, and `apps/hermes` (which does depend on `@hermes/agent`) is
where that structural match is actually type-checked against the real type.
