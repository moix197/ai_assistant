# @hermes/google-auth

Google OAuth2 identity: PKCE + state-nonce connect flow, a scope registry, and
an AES-256-GCM token envelope. Never imports `@hermes/store` — persistence is
an injected `GoogleAccountRepo` port, bound in
`apps/hermes/src/store/build-google-account-repo.ts`. Never imports
`@hermes/channels` — command handlers and the OAuth callback route in
`apps/hermes` are the only callers. Depends on `@hermes/core` only.

The `GoogleAccount` row shape itself (`googleAccountSchema`, and the
`tokenEnvelopeSchema` it embeds) lives in `@hermes/core` and is re-exported
from here — exactly how `LlmUsageEntry` is shared between `@hermes/llm` and
`@hermes/store`. `@hermes/store` reads it from `core` too, so the two
siblings never import each other. What stays here is the *port*
(`GoogleAccountRepo`, a consumer-defined interface) and the crypto that
seals and opens an envelope.

## Flow shape

- `generatePkcePair()` — RFC 7636 S256 verifier/challenge pair.
- `createPendingConnectionStore(clock)` — an in-memory `Map<state,
  PendingConnection>`, 10-minute TTL. `createPendingConnection` mints a
  high-entropy `state` (256-bit, `randomBytes`); `consumePendingConnection`
  deletes on read, so an unknown, expired, or replayed state all collapse
  into the same "not found" result — one branch, not three. Restart drops
  any in-flight connection, the same tradeoff the approval gate's own
  pending map accepts; the operator re-runs `/connect google`.
- `createConnectFlow(deps)` — `startConnect(channel, channelUserId, chatId,
  scopes)` mints PKCE + state, records the pending entry (including the
  requested `scopes`), and returns the Google authorize URL (built with
  `include_granted_scopes: "true"` — see "Scope registry" below).
  `completeConnect(state, code)` consumes the pending entry
  (invalid/expired/replayed state all return `{ ok: false, reason:
  "invalid_state" }`), exchanges `code` for tokens using the stored PKCE
  verifier, seals both tokens into one envelope, and upserts the account via
  the injected `GoogleAccountRepo`. The account's `scopes` are the ones
  Google's token response **granted** (its space-delimited `scope`), never the
  ones `startConnect` requested — granular consent lets a user deselect
  individual checkboxes. Identity is non-negotiable regardless of what was
  requested: a grant that doesn't cover `IDENTITY_SCOPES` returns
  `{ ok: false, reason: "missing_scopes" }` and writes no row. Anything else
  the *pending connection itself* requested (e.g. `SHEETS_SCOPES` via
  `/connect google sheets`) but Google didn't grant is a **partial grant**,
  not a rejection: the account is still persisted with whatever was granted,
  and the result carries a `missingScopes: string[]` field alongside the
  usual `ok: true, email, chatId` — `{ ok: true, email, chatId,
  missingScopes }` — for the caller to render as a distinct "connected, but
  Sheets wasn't granted" message. The authorization `code` and the raw tokens
  never appear in a log line or a return value anywhere in this package.

## Token envelope

`sealToken`/`openToken` (`token-crypto.ts`) implement AES-256-GCM with a
fresh random 12-byte IV per seal. The envelope is a self-describing
`{ v: 1, iv, tag, ct }` (all base64) — opaque to `packages/store`, which
persists and reads it back as `jsonb` without ever decrypting it. A tampered
`ct`/`tag` or the wrong key makes `openToken` throw `TokenDecryptError`
rather than return corrupted plaintext.

One envelope holds both the access and refresh token (serialized as one JSON
string before sealing) — `google-auth-library` has no requirement that they
be sealed separately; one seal/open call is strictly simpler than two and
carries no less protection, since both live behind the same key and the same
row.

## Scope registry

`IDENTITY_SCOPES` (`openid`, `userinfo.email`) is what bare `/connect google`
requests. `SHEETS_SCOPES` (`spreadsheets`) is the incremental scope
`/connect google sheets` requests on top of identity —
`resolveConnectScopes(argument)` maps the `/connect` sub-argument (`""` or
`"sheets"`, case-insensitive, whitespace-trimmed) to the resulting
requested-scope list, returning `undefined` for anything else so the caller
falls back to its usage-help message. `hasRequiredScopes(granted, required)`
and `TOOL_REQUIRED_SCOPES` (a tool name → required scopes map, seeded since
`04-google-auth` with only `whoami`) are the primitives later phases build
incremental consent on: a tool whose required scopes aren't yet granted
returns a structured `{ ok: false, reason: "missing_scope", scope }` for the
model to relay as "run /connect google", never a live escalation prompt the
agent itself raises.

`buildAuthUrl` sets `include_granted_scopes: "true"` on the authorize URL, so
a user who already granted identity and now runs `/connect google sheets`
gets back the **cumulative** grant in the token response — Google's own
accounting is authoritative, and `completeConnect` never unions scopes across
connects itself. `upsertAccount` keeps its existing plain-overwrite
semantics: the persisted `scopes` are exactly what the latest `completeConnect`
call was granted.

## Token refresh (`refresh.ts`)

`createRefreshCoordinator(deps)` exposes **one** public entry point:
`getValidAccessToken(account): Promise<{ accessToken, account }>` — the
single seam every caller needing a live access token goes through, today
`apps/hermes/src/google/refresh-sweep.ts`'s boot-owned sweep, and any future
request-path tool call with no design change. There is deliberately no
second "force refresh" function.

- **Fresh vs. stale is one constant.** `account.expiresAt.getTime() -
  now() < REFRESH_SKEW_MS` (10 minutes, exported) decides it. A fresh
  account decrypts and returns the cached token unchanged — zero network
  calls. A stale one refreshes through a single-flight `Map<accountKey,
  Promise<...>>` keyed on `(channel, channelUserId)`, entry deleted in a
  `finally`, so concurrent callers for the same account share one underlying
  refresh and a failed refresh never poisons a later, independent attempt.
  `apps/hermes/src/google/refresh-sweep.ts`'s `listAccountsExpiringBefore`
  cutoff imports this same `REFRESH_SKEW_MS` rather than hardcoding its own
  duration — the sweep's "expiring soon" and this function's "needs
  refresh" can never drift into two independently-tuned numbers.
- **The refresh call is an injected port, not an SDK client.**
  `RefreshAccessTokenPort` (`oauth-client.ts`) is
  `(refreshToken: string) => Promise<RefreshedAccessToken>` — a function type
  this package owns, so the coordinator never touches `google-auth-library`
  and its tests fake the port rather than an SDK internal.
  `createGoogleRefreshAccessToken(oauthClient)` is the production
  implementation: it builds a throwaway `OAuth2Client` per call and uses the
  public `refreshAccessToken()` on it, so nothing is shared between concurrent
  refreshes of different accounts. `createRefreshCoordinator` takes the port
  and only the port — **required**, not an optional field with an
  `oauthClient` fallback beside it, which made "neither supplied"
  representable and turned it into a runtime throw. `boot.ts` calls
  `createGoogleRefreshAccessToken` itself and passes the result.
- **`RefreshFailedError`** carries a `reason`: `"invalid_grant"` (Google
  reports the refresh token revoked/expired, or the stored envelope fails to
  decrypt — both leave the account equally unusable) drives
  `refresh-sweep.ts`'s disconnect-and-alert branch; `"transient"` (network
  failure, a Google 5xx) is retried on the next sweep tick with the stored
  row untouched. Its `cause` is typed `RefreshErrorDetail` (`message`,
  `status`, `error`, `errorDescription`) — a whitelist extract, because the
  raw gaxios rejection carries the form-encoded token request, client secret
  included, on `config.data`.
- **Never persists.** `getValidAccessToken` returns the updated `GoogleAccount`
  (a fresh `token_envelope`/`expiresAt`) but does not write it —
  `refresh-sweep.ts` persists via the injected `repo.upsertAccount`, keeping
  this package's "never imports `@hermes/store`" boundary intact even for
  writes that happen mid-refresh.
- **Correctness depends on exactly one Hermes process per database** — the
  advisory lock `packages/store/src/advisory-lock.ts` already enforces (see
  `.ai/decisions/google-token-refresh.md`). A future entrypoint that calls
  `getValidAccessToken` from outside `boot()` (a standalone script, a second
  worker process) would share neither this map nor that guarantee.

## Revoke (`revoke.ts`, `05-google-sheets` Phase 6)

`revokeToken(refreshToken, { logger, fetchImpl? })` calls Google's OAuth2
revoke endpoint (`POST https://oauth2.googleapis.com/revoke?token=<refreshToken>`),
built on `@hermes/core`'s shared `withHttpRetry` — the same retrying-fetch
primitive `@hermes/google-sheets`' client and `@hermes/llm`'s adapter use, not
a bare `fetch`.

**Never throws.** `apps/hermes/src/handlers/disconnect.ts`'s contract is
"attempt revoke, then delete the local row regardless": a network failure or
timeout is retried once, then logged (`warn`) and swallowed; a non-2xx
response (Google already applied the request — e.g. an already-revoked or
invalid token) is logged and swallowed immediately, never retried. Either
way `revokeToken` resolves, so a revoke failure never blocks or changes the
local disconnect, and the user-facing "Disconnected." reply is identical
regardless of whether the grant actually left Google.

`refreshToken` itself never appears in a log line or a thrown error's
message — the same discipline `04-google-auth` Phase 2 applies to the
authorization code in `oauth-client.ts`/`connect-flow.ts`. `disconnect.ts`
never touches key material itself: `apps/hermes/src/boot.ts`'s
`buildDecryptRefreshToken` holds the `cryptoKey` and decrypts the stored
envelope (via the shared `decryptTokenEnvelope`, also used by `refresh.ts`)
on `disconnect.ts`'s behalf, handing the handler only the narrow
`decryptRefreshToken` capability. Either way the plaintext exists only in
memory for this one call; `packages/store` never sees it.

The refresh-sweep's `invalid_grant` disconnect path (`markDisconnected`,
"Token refresh" above) does not call `revokeToken`: by the time that path
runs, Google has already told Hermes the refresh token is revoked or
expired, so there is nothing live left to revoke.

See `.ai/decisions/google-oauth-flow.md`, `.ai/decisions/google-token-encryption.md`,
and `.ai/decisions/google-token-refresh.md`.
