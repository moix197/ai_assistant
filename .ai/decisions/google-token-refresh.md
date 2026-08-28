# Google token refresh: one seam, a boot-owned sweep, single-flight guaranteed by the advisory lock

**Decision:** `packages/google-auth/src/refresh.ts`'s `createRefreshCoordinator`
exposes exactly one public entry point, `getValidAccessToken(account):
Promise<{ accessToken, account }>`. A fresh account (`expiresAt` more than
`REFRESH_SKEW_MS` — 10 minutes — away) decrypts and returns the cached token
unchanged, zero network calls. A stale one refreshes through a single-flight
`Map<accountKey, Promise<...>>` keyed on `(channel, channelUserId)`, entry
deleted in a `finally`. `apps/hermes/src/google/refresh-sweep.ts`'s
`createRefreshSweep` — constructed and `start()`ed inside `boot.ts`'s
`wireRuntimeAndShutdown`, which runs only after `acquireInstanceLockOrExit`
has returned a held lock — calls this same function for every account its
`listAccountsExpiringBefore` query returns, once immediately at boot and then
every `REFRESH_SWEEP_INTERVAL_MS` (5 minutes). A refresh classified
`invalid_grant` marks the account disconnected and alerts the original chat;
a transient failure is logged and retried next tick.

**Why:**

- **One seam, not two.** An earlier draft of this design put the
  single-flight map directly behind a sweep-only `refreshAccount` function.
  That was wrong: `whoami` (Phase 3) never calls a live Google API this
  phase, but the first future tool that does (Gmail, Calendar) needs a
  request-path refresh path, and a second, independently-built path is
  exactly the design this project would then have to retire and rebuild.
  `getValidAccessToken` is deliberately generic over "who's asking" — the
  sweep and a future request-path tool call are both just callers.
- **`REFRESH_SKEW_MS` is the single source of truth for "needs refresh."**
  `refresh-sweep.ts`'s `listAccountsExpiringBefore` cutoff imports this exact
  constant from `@hermes/google-auth` rather than hardcoding its own
  duration, so the sweep's "expiring soon" query and the coordinator's own
  staleness check can never drift into two independently-tuned numbers.
  `REFRESH_SWEEP_INTERVAL_MS` (5 minutes) is deliberately half of
  `REFRESH_SKEW_MS` (10 minutes), so one missed or slow tick still leaves a
  full interval of buffer before a token actually expires.
- **Single-flight is sufficient, not merely convenient, specifically because
  of the advisory lock.** `packages/store/src/advisory-lock.ts`'s
  `pg_try_advisory_lock` plus `boot.ts`'s non-zero exit on a lost race
  guarantee exactly one Hermes process per database — for the whole process
  lifetime, not just at boot: the dedicated lock client carries an `'error'`
  listener that logs and exits non-zero when that connection dies, since
  Postgres frees a session-level lock the instant its connection drops and a
  surviving process would then be racing whoever acquires it next.
  Verified by inspection,
  not merely assumed: `boot()` calls `acquireInstanceLockOrExit` and returns
  early when the lock isn't held; `wireRuntimeAndShutdown` — the only place
  the sweep is constructed and `start()`ed — is called strictly after that
  check succeeds. **Constraint this creates for future work:** token refresh
  must never be reachable from an entrypoint outside `boot()` (a standalone
  script, a second worker process) — such an entrypoint would share neither
  this in-process map nor the lock's protection, silently reintroducing the
  race the lock exists to prevent, with no test catching it.
- **The coordinator depends on a `RefreshAccessTokenPort`, not on an
  `OAuth2Client`.** `oauth-client.ts` declares
  `type RefreshAccessTokenPort = (refreshToken: string) =>
  Promise<RefreshedAccessToken>` — a function type this package owns — and
  `createRefreshCoordinator` takes an implementation of it as its single
  **required** dependency, exactly the
  injection idiom `GoogleAccountRepo`/`ThreadRepo`/`LlmUsageRepo` already use.
  Required, not an optional port beside an optional `oauthClient` the
  coordinator would wrap itself: that shape briefly existed, and it made an
  invalid combination (neither supplied) representable and deferred it to a
  runtime throw. `apps/hermes/src/boot.ts`'s `buildRefreshSweep` calls
  `createGoogleRefreshAccessToken(oauthClient)` and passes the port, which
  also keeps `google-auth-library` out of the coordinator's own imports
  entirely. That production adapter
  builds a **throwaway `OAuth2Client` per call** and uses the public
  `refreshAccessToken()` on it. The shared-state hazard that shaped the
  earlier design is real — `refreshAccessToken()`/`getAccessToken()` read and
  write `this.credentials` — but it is a property of *sharing a client*, not
  of the public API, and a per-call instance has none of it to race on.
  Constructing one is field assignment plus `super(opts)`, no I/O.
  `refresh.test.ts` fakes the port; nothing in this package's tests stands in
  for an SDK internal any more.
- **Correcting the earlier rationale, which was wrong on the facts.** A prior
  version of this document justified casting to reach `OAuth2Client`'s
  `protected refreshToken()` on the grounds that `protected` there is "an
  SDK-internal visibility marker, not a documented public/private API
  boundary." That is false: the compiled SDK
  (`google-auth-library@9.15.1`, `build/src/auth/oauth2client.d.ts`) carries a
  literal `@private` JSDoc tag on that method. It is a declared private API,
  and depending on it was a real (if small) upgrade hazard. The document also
  presented the clean alternative as *rejected on correctness grounds*; it was
  not — it was rejected because `__tests__/refresh.test.ts` mocked
  `OAuth2Client.refreshToken` directly, so the swap could not reach the mock.
  A test's mocking seam was dictating production design. The fix was to change
  the seam: the tests now mock our own port, and the cast is gone.
- **The SDK has a de-duplication layer of its own; ours is not redundant, but
  it is also not the whole story.** `OAuth2Client.refreshToken()` keeps a
  `refreshTokenPromises` map keyed on the refresh-token string, so under the
  *old* shared-client design our single-flight map was a second layer rather
  than the sole defense. Under the per-call-client port it is the only
  in-process de-duplication, since that map is per-client. Either way our map
  earns its place: it is keyed on `(channel, channelUserId)` and short-circuits
  before the envelope decrypt, so concurrent callers skip a redundant AES
  open as well as a redundant HTTP round-trip.
- **Failure classification collapses two causes into one action.** Both
  Google reporting `invalid_grant` (a revoked or expired refresh token) and
  the stored envelope failing to decrypt leave an account equally unusable —
  both are `RefreshFailedError`'s `reason: "invalid_grant"`, driving the same
  disconnect-and-alert branch. Everything else (network failure, a Google
  5xx) is `reason: "transient"`: logged, the row untouched, retried next
  tick — the same "don't act on noise" posture the budget ceiling and
  provider rate-limit backoff already take elsewhere in this codebase.
- **`markDisconnected` removes the row — verified at execution time, not
  assumed from the plan's prose alone.** Settled decision 16 says "marks the
  account disconnected"; this phase confirmed that means the same `DELETE`
  `/disconnect` already performs (`packages/store/src/google-account-repo.ts`),
  by checking `status.ts`/`disconnect.ts`: both already treat "no row" as the
  entire not-connected state, so a refresh-triggered disconnect and a
  manual one are indistinguishable to `whoami`/`/status` — no new
  disconnected-but-present state to reason about.
- **The coordinator never persists.** `getValidAccessToken` returns the
  updated `GoogleAccount` (fresh `token_envelope`/`expiresAt`) but leaves the
  write to the caller — `refresh-sweep.ts`'s `repo.updateRefreshedTokens` —
  keeping `packages/google-auth`'s "never imports `@hermes/store`" boundary
  intact even for a write that happens mid-refresh.
- **The sweep's write is UPDATE-only (`updateRefreshedTokens`), never the
  connect path's `upsertAccount`.** The sweep acts on a row snapshot read one
  HTTP round-trip ago, so an upsert would re-INSERT a row `/disconnect`
  deleted while the refresh was in flight — resurrecting the account with a
  live refresh token, and every later tick keeping it alive — and would
  overwrite `scopes`/`chat_id` a `/connect` granted mid-tick with the stale
  snapshot's values. `updateRefreshedTokens` writes only `token_envelope`/
  `expires_at`/`updated_at`, and matches zero rows when the account is gone.
- **One account's failure never costs the rest of the tick.** Failure
  handling is wrapped where `refreshOneAccount` catches, and the reconnect
  alert is isolated from `markDisconnected`, so a blocked bot (Telegram 403)
  or a throwing handler is logged rather than unwinding `runOnce`'s loop and
  silently skipping every account after it. A terminal `invalid_grant`
  disconnect is logged (warn, with channel/channelUserId/reason) *before* the
  mutation — it needs human action, so it must not be the one branch that
  deletes a row and messages a user while leaving no trace in the log.
- **Ticks never overlap.** `tick()` skips (and logs) while a previous
  `runOnce()` is still in flight. Beyond avoiding concurrent refreshes of the
  same account, this is what makes `stop()` correct: `inFlight` was otherwise
  overwritten by each new tick, so `stop()` could await only the newest one
  and return while an older tick still had queries out — after which `boot.ts`
  releases the advisory lock and ends the pool.
- **Shutdown budget: `sweep.stop()` gets its own 1s bound
  (`SWEEP_STOP_TIMEOUT_MS`), the same size as `TELEMETRY_FLUSH_TIMEOUT_MS`.**
  `DRAIN_TIMEOUT_MS` (5s) + `TELEMETRY_FLUSH_TIMEOUT_MS` (1s) can already
  consume up to 6s of the 8s `HARD_EXIT_TIMEOUT_MS` ceiling; adding the
  sweep's own 1s leaves `lock.release()`/`pool.end()`/the final log at least
  1s of margin. A stuck `stop()` (an in-flight refresh mid-tick) degrades to
  "pick up where it left off on the next boot's immediate sweep pass," the
  same tradeoff the telemetry flush already accepts, rather than starving
  the rest of shutdown.

**Rejected:**

- *A sweep-only `refreshAccount` function, with the single-flight map private
  to the sweep* — the exact "two refresh paths" hazard this decision exists
  to prevent; a future request-path tool would either duplicate the map or
  bypass single-flighting entirely.
- *A cron-style standalone refresh script outside `boot()`* — would share
  neither the in-process single-flight map nor the advisory lock's
  single-instance guarantee, reintroducing the concurrent-refresh race this
  design depends on the lock to prevent.
- *Refreshing via the public `OAuth2Client.refreshAccessToken()`/
  `getAccessToken()` **on a shared client*** — both mutate that client's own
  `credentials` field; concurrent refreshes for different accounts through one
  instance would race on that shared state. (The same public method on a
  per-call throwaway client is what the production port now uses — the hazard
  was the sharing, not the method.)
- *Reusing `buildConnectFlow`'s `OAuth2Client` instance for the sweep's
  coordinator* — no correctness reason to share one (`getToken`/`refreshToken`
  are both stateless-per-call), and a shared instance would only couple two
  otherwise-independent construction sites for no benefit.
- *Keeping the cast to `OAuth2Client`'s `protected refreshToken()`, on the
  grounds that swapping it out would break `__tests__/refresh.test.ts`.* This
  was the standing position for one review cycle and it was the wrong call:
  those tests built `oauthClient` as `{ refreshToken } as unknown as
  OAuth2Client` and asserted against that mock, so a per-call-client
  implementation could not reach it — but "the tests mock a third-party
  internal" is a reason to fix the tests, not to keep production code bound to
  a `@private` SDK method. The seam moved to a port we own; the tests now fake
  that port and assert the same things (call count, call args, single-flight
  de-duplication) without naming `google-auth-library` at all.
- *Attaching the raw refresh rejection as `RefreshFailedError`'s `cause`.* A
  gaxios error carries the whole outgoing token request on `config.data` —
  form-encoded `client_secret` and refresh token — and `util.inspect` prints
  `[cause]` recursively, so one `logger.error(err)`, `unhandledRejection`
  handler, or error-reporting SDK would publish the secret. `cause` is now
  typed as `RefreshErrorDetail` (`message`, `status`, `error`,
  `errorDescription`), built by a whitelist extractor, which makes attaching
  the raw error a compile error rather than something review has to catch.

**Constraints it creates:**

- Any future Google-backed tool needing a live access token calls
  `getValidAccessToken` — never a new refresh function, never the raw
  `oauth-client.ts` primitives directly.
- Token refresh must never be wired from any entrypoint other than
  `boot()`'s `wireRuntimeAndShutdown`, which must keep running strictly after
  `acquireInstanceLockOrExit` succeeds.
- A future change to `REFRESH_SKEW_MS`/`REFRESH_SWEEP_INTERVAL_MS` must
  preserve the "skew is at least double the interval" relationship, or a slow
  tick can no longer be guaranteed to still leave buffer before expiry.
