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
  guarantee exactly one Hermes process per database. Verified by inspection,
  not merely assumed: `boot()` calls `acquireInstanceLockOrExit` and returns
  early when the lock isn't held; `wireRuntimeAndShutdown` — the only place
  the sweep is constructed and `start()`ed — is called strictly after that
  check succeeds. **Constraint this creates for future work:** token refresh
  must never be reachable from an entrypoint outside `boot()` (a standalone
  script, a second worker process) — such an entrypoint would share neither
  this in-process map nor the lock's protection, silently reintroducing the
  race the lock exists to prevent, with no test catching it.
- **`refreshAccessToken` (`oauth-client.ts`) reaches around `OAuth2Client`'s
  `protected refreshToken(refreshToken)`, deliberately not the public
  `refreshAccessToken()`/`getAccessToken()`.** Both public methods read and
  write the client instance's own `credentials` field; this coordinator may
  refresh several accounts through one shared `OAuth2Client`, and mutating
  shared state per refresh would race across concurrent, different-account
  calls. `refreshToken`/its `refreshTokenNoCache` delegate take the refresh
  token as an explicit argument and touch no shared state — `protected` here
  is an SDK-internal visibility marker, not a documented public/private
  boundary, so this narrow, documented reach-around is safer than the
  alternative.
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
  write to the caller — `refresh-sweep.ts`'s `repo.upsertAccount` — keeping
  `packages/google-auth`'s "never imports `@hermes/store`" boundary intact
  even for a write that happens mid-refresh.
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
  `getAccessToken()`* — both mutate the shared client's own `credentials`
  field; concurrent refreshes for different accounts through one client
  instance would race on that shared state.
- *Reusing `buildConnectFlow`'s `OAuth2Client` instance for the sweep's
  coordinator* — no correctness reason to share one (`getToken`/`refreshToken`
  are both stateless-per-call), and a shared instance would only couple two
  otherwise-independent construction sites for no benefit.
- *A throwaway `OAuth2Client` constructed per refresh call, calling the
  public `refreshAccessToken()` on that isolated instance instead of reaching
  around the shared client's protected `refreshToken()`.* Re-examined during
  Phase 4 code review specifically to see whether the protected-API cast
  could be dropped. Verified against the installed
  `google-auth-library@9.15.1` source
  (`node_modules/.pnpm/google-auth-library@9.15.1/node_modules/google-auth-library/build/src/auth/oauth2client.js`):
  the constructor (line ~45) is indeed cheap — field assignment plus a
  `super(opts)` call, no I/O — and the public `refreshAccessToken()`
  (line ~238, no callback given) delegates to `refreshAccessTokenAsync()`
  (line ~246), which itself calls
  `this.refreshToken(this.credentials.refresh_token)` — the very protected
  method the cast reaches around, just invoked internally by the SDK on the
  throwaway instance instead of externally by our code on the shared one.
  Behaviorally sound in principle, but rejected because it breaks
  `__tests__/refresh.test.ts` without editing it: every test there builds
  `oauthClient` as `{ refreshToken } as unknown as OAuth2Client`
  (`fakeOAuthClient`) and asserts directly against that mock function (call
  count, call args, single-flight de-duplication). A per-call
  throwaway-client implementation cannot reach that mock at all — it would
  have to construct a brand-new *real* `OAuth2Client` and invoke its own
  real `refreshToken`, which for a fake object carrying no
  `_clientId`/`_clientSecret` would either throw building the request or
  attempt a genuine `POST` to `https://oauth2.googleapis.com/token`, never
  the injected fake. Making the swap pass would require rewriting
  `refresh.test.ts` to mock HTTP transport instead of the client method —
  exactly the "requires editing the tests to pass" condition this cleanup
  was scoped to avoid. The cast-based implementation in `oauth-client.ts`
  was left unchanged.

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
