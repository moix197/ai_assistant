# @hermes/google-auth

Google OAuth2 identity: PKCE + state-nonce connect flow, a scope registry, and
an AES-256-GCM token envelope. Never imports `@hermes/store` — persistence is
an injected `GoogleAccountRepo` port, bound in
`apps/hermes/src/store/build-google-account-repo.ts`. Never imports
`@hermes/channels` — command handlers and the OAuth callback route in
`apps/hermes` are the only callers.

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
  scopes)` mints PKCE + state, records the pending entry, and returns the
  Google authorize URL. `completeConnect(state, code)` consumes the pending
  entry (invalid/expired/replayed state all return `{ ok: false, reason:
  "invalid_state" }`), exchanges `code` for tokens using the stored PKCE
  verifier, seals both tokens into one envelope, and upserts the account via
  the injected `GoogleAccountRepo`. The authorization `code` and the raw
  tokens never appear in a log line or a return value anywhere in this
  package.

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

`IDENTITY_SCOPES` (`openid`, `userinfo.email`) is the only scope this phase's
`/connect google` requests. `hasRequiredScopes(granted, required)` and
`TOOL_REQUIRED_SCOPES` (a tool name → required scopes map, seeded this phase
with only `whoami`) are the primitive later phases build incremental consent
on: a tool whose required scopes aren't yet granted returns a structured
`{ ok: false, reason: "missing_scope", scope }` for the model to relay as
"run /connect google", never a live escalation prompt the agent itself
raises.

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
- **`refreshAccessToken` (`oauth-client.ts`)** wraps `OAuth2Client`'s
  `protected refreshToken(refreshToken)` — the one SDK call that takes an
  explicit refresh token and returns fresh credentials without mutating the
  client's own `credentials` field, unlike the public
  `refreshAccessToken()`/`getAccessToken()`. That matters because a single
  `OAuth2Client` instance may refresh several accounts through this
  coordinator; a call that reads/writes shared client state would race.
- **`RefreshFailedError`** carries a `reason`: `"invalid_grant"` (Google
  reports the refresh token revoked/expired, or the stored envelope fails to
  decrypt — both leave the account equally unusable) drives
  `refresh-sweep.ts`'s disconnect-and-alert branch; `"transient"` (network
  failure, a Google 5xx) is retried on the next sweep tick with the stored
  row untouched.
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

See `.ai/decisions/google-oauth-flow.md`, `.ai/decisions/google-token-encryption.md`,
and `.ai/decisions/google-token-refresh.md`.
