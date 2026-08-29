# Google identity via a loopback OAuth2 code flow: PKCE + state nonce, in-memory pending connections, the agent never sees a credential

**Decision:** `/connect google` mints a PKCE verifier/challenge pair and a
high-entropy `state`, records a pending connection in an in-memory map
(`packages/google-auth/src/pending-connections.ts`), and replies with a
Google authorize URL. Google redirects back to
`http://localhost:3000/oauth/callback` (`apps/hermes`'s existing health
server, extended to be path/query-aware), which consumes the pending entry
by `state`, exchanges the authorization code for tokens using the PKCE
verifier, and reports the result into the connecting Telegram chat — never
into the browser tab. The OAuth2 client is Google Cloud console's **Web
application** type, not "Desktop app", because the redirect URI must
exact-match and the container's fixed published port (`3000:3000`) makes
that hold. `packages/agent`'s tool loop never sees an auth URL, a `state`, a
code, or a token — command handlers own the whole flow, outside the model's
context entirely.

**Why:**

- **The callback's authorization is the state nonce plus PKCE — nothing
  else.** A pending connection is keyed by a 256-bit random `state`
  (`randomBytes(32)`, base64url) holding `{ channel, channelUserId, chatId,
  scopes, verifier, exp }`, 10-minute TTL. `consumePendingConnection` deletes
  on read before checking expiry, so an unknown, expired, or replayed
  `state` collapse into the identical `{ ok: false, reason: "invalid_state"
  }` — one branch, not three, the same "expired, ask again" collapse
  [approval-gate-design](approval-gate-design.md) uses for restart and
  already-answered callbacks. A `Map` keyed on the exact `state` string is an
  O(1) hash lookup on an unguessable key, not a byte-by-byte compare against
  a list of live states — no timing side channel to defend separately.
- **In-memory, not persisted — a deliberate mirror of the approval gate's
  own tradeoff.** A `/connect google` in flight when the process restarts is
  simply gone; the operator re-runs the command. No queue, no durability. The
  alternative (a persisted pending-connection table) buys nothing here: the
  10-minute window is short, and a lost in-flight connect costs the operator
  one retry, not lost state.
- **The browser's landing page never echoes `code`, `state`, or any token
  material** — a static "you can close this tab" (success), a generic failure
  message, or a static "not approved" page (Google's denial redirect),
  nothing else in the rendered HTML. The result — "Connected as `<email>`" —
  is reported into Telegram instead, the channel the operator is actually
  watching. The detail withheld from the browser goes to the **log**: every
  failure branch logs server-side (`error.message` only — never the error
  object or its `cause`, whose chain can carry a `GaxiosError` whose
  `config.data` holds `GOOGLE_CLIENT_SECRET` and the authorization code), so
  a connect that never works is debuggable from the operator's side without
  the browser learning anything.
- **The callback answers GET only, and treats `?error=` as a finished
  flow.** Google's redirect is always a GET; anything else gets a `405` and
  never reaches `completeConnect`, so no single-use `state` is spent on it.
  A denial redirect (`?error=access_denied`) consumes the pending entry for
  that `state` — `completeConnect` can't be the seam that clears it, since
  there is no code to exchange — rather than leaving it live for the rest of
  its 10-minute TTL.
- **The health server, not a new server, serves the callback.** `/health`
  today compares `req.url === "/health"` with strict equality — no query
  string handling at all. Rather than stand up a second HTTP listener, this
  plan makes the existing server path/query-aware
  (`new URL(req.url, "http://localhost").pathname`), adding `/oauth/callback`
  as a second route. The container already publishes `3000:3000`, so no
  network change is needed for the redirect to reach it from the host
  browser.
- **The health server is constructed before the Telegram channel exists in
  `boot()`, and this plan does not reorder that documented boot sequence for
  one route.** The callback needs `channel.send` to deliver the confirmation,
  but boot's step order (config -> ... -> health server -> poller -> handlers)
  is load-bearing elsewhere. Instead, `apps/hermes/src/google/
  build-oauth-callback-route.ts`'s `createOauthCallbackRoute({ logger })`
  returns a mutable holder — `{ handleRequest, bind({ connectFlow, notify,
  pendingStore }) }` — constructed early (before `serveHealth`) and passed
  into the health server's router unbound; `wireRuntimeAndShutdown` calls
  `.bind()` once the channel and `connectFlow` exist. The logger is a
  construction-time dep, not part of the binding: it exists from `boot()`'s
  fourth line, and the pre-`bind()` window must be able to log too. A callback arriving before `bind()` gets a
  `503` — only reachable if Google redirects back before Hermes finishes
  booting, which cannot happen (the operator can't reach `/connect google`
  until the bot is live). This indirection is this plan's own design, not
  covered by any of the 16 settled decisions carried into this phase.
- **The agent cannot mint a consent URL or escalate its own scopes.**
  `/connect`, `/status`, `/disconnect` are command handlers, not tools — the
  model never sees them. A tool that needs a scope it doesn't have returns a
  structured `{ ok: false, reason: "missing_scope" | "not_connected" }` for
  the model to relay as "run /connect google"; incremental consent is the
  exact primitive an injected agent would use to self-escalate, so every
  scope Hermes holds was granted by a human typing a command, never by the
  model. Tool handlers that need a Google client receive an authenticated
  wrapper (future phases), never the credential itself — nothing in model
  context can exfiltrate a token that was never placed there. Note what
  `/disconnect` does and does not mean — see **Deferred** below.
- **The scope registry is the single place a tool's requirement is
  declared.** `packages/google-auth/src/scopes.ts`'s `IDENTITY_SCOPES` is the
  only scope this phase's `/connect google` requests (`openid`,
  `userinfo.email` — non-sensitive, needing no Google verification review).
  `hasRequiredScopes`/`TOOL_REQUIRED_SCOPES` (seeded this phase with only
  `whoami`) is the primitive later phases build incremental, per-tool consent
  on, consulted at tool-selection time starting Phase 3.
- **`google_accounts.scopes` records what Google *granted*, never what Hermes
  *requested*.** `exchangeCode` parses the token response's space-delimited
  `scope` and `completeConnect` persists that, so
  `hasRequiredScopes(account.scopes, …)` answers "do we hold this?" rather
  than "did we ask for this?". The distinction is load-bearing because
  Google's granular-consent screen lets a user deselect individual checkboxes:
  the requested list would have marked such an account fully scoped, and the
  first Gmail/Calendar tool to trust it would pass its scope check and then
  take a 403 from Google. A grant that does not cover `IDENTITY_SCOPES` fails
  the connect outright (`{ ok: false, reason: "missing_scopes" }`, the OAuth
  callback route's existing generic failure branch) and writes no row — a
  half-connected account is worse than none.
- **Mutations/outbound sends gate, pure reads within an already-consented
  scope do not.** `whoami` (Phase 3) is the worked example: it projects the
  `google_email` captured at connect time, makes no live Google API call, and
  is `requiresApproval: false` — a pure, idempotent identity check, not a
  consequence. This is the same policy
  [approval-gate-design](approval-gate-design.md) establishes for gated tool
  calls generally, applied to the OAuth surface's own first tool.

**Rejected:**

- *Desktop app / installed-app OAuth client type* — no fixed redirect URI to
  exact-match against; the Web application type plus the container's
  published port is what makes the loopback redirect reliable.
- *A second HTTP listener for the callback* — one more port to publish, one
  more health/readiness surface to reason about, for a single route the
  existing server can carry once it learns query strings.
- *Reporting the connection result in the browser tab* — the operator is
  watching Telegram, not a browser window left open mid-flow; the tab is
  disposable and must never render a token or code regardless.
- *Persisting pending connections* — see the in-memory tradeoff above.
- *Reordering `boot()` to construct the channel before the health server* —
  boot's step order is documented as load-bearing elsewhere
  ([architecture](../architecture.md#boot-and-shutdown-order)); the mutable
  holder costs one small indirection instead.

**Closed out (`05-google-sheets` Phase 6): `/disconnect` now revokes at
Google.** `createDisconnectHandler` (`apps/hermes/src/handlers/disconnect.ts`)
decrypts the stored refresh token and calls `@hermes/google-auth`'s
`revokeToken` (`POST https://oauth2.googleapis.com/revoke`) before
`repo.deleteAccount` — resolving the "revoke failure has no decided fallback"
question below as: **always delete locally regardless**. `revokeToken` never
throws — any failure (network, timeout, or a non-2xx response) is logged and
swallowed — so the local disconnect and its reply never depend on whether the
grant actually left Google. The sweep's `invalid_grant` path
(`markDisconnected`) still does not revoke: by the time that path runs, the
refresh token has already failed at Google (revoked, expired, or invalid), so
there is nothing live left to revoke. See
`packages/google-auth/README.md`'s "Revoke" section for the full design.

The paragraphs below record the original deferral rationale, kept for
context on *why* this shipped as a separate phase rather than inside
`04-google-auth`:

`createDisconnectHandler` used to call `repo.deleteAccount` and nothing else.
Hermes forgot the account and every stored token became unreachable, but the
*grant itself stayed live* in the user's Google account permissions page
until they removed it there.

Deliberately deferred at the time, because:

- **It was outside `04-google-auth`'s scope.** That plan scoped `/disconnect`
  as the local inverse of `/connect`; a revoke is an outbound call to a third
  party, with its own failure modes, and was never designed there.
- **Revoke failure had no decided fallback.** If `POST
  https://oauth2.googleapis.com/revoke` fails (network, already-revoked,
  rate-limited), the handler had to choose: keep the row and refuse to
  disconnect, delete anyway and strand a live grant, or retry in the
  background. `05-google-sheets` Phase 6 picks "delete anyway" — see above.

**Constraints it creates:**

- `packages/google-auth` never imports `@hermes/channels` or `@hermes/store`
  — `GoogleAccountRepo` is an injected port, and the flow's own types
  (`channel`, `channelUserId`, `chatId` as plain strings) are channel-neutral
  by construction, the same discipline `packages/agent`'s `ThreadRepo`/
  `ApprovalGate` ports already hold.
- Any future tool needing a scope beyond `IDENTITY_SCOPES` must register it
  in `packages/google-auth/src/scopes.ts`'s `TOOL_REQUIRED_SCOPES`, not
  inline a check elsewhere — that map is the single source of truth
  incremental consent reads from.
- Token refresh (Phase 4) must go through the flow's own seam, not
  reimplement pending-connection or state-nonce logic — see
  [google-token-refresh](google-token-refresh.md).
