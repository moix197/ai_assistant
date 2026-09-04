# apps/hermes

The process entry point. `src/index.ts` only calls `boot()` — no logic lives
in the entry point itself.

## Boot sequence

1. `loadConfig()` — exits `1` with a message naming the bad var on failure
   (`@hermes/config`'s `ConfigError`).
2. `assertModelsPricedOrExit()` — runs `@hermes/llm`'s `assertModelsPriced`
   over `LLM_PRIMARY_MODEL` and, when set, `LLM_FALLBACK_MODEL`, exiting `1`
   naming the offending id. Deliberately before the logger and before any DB
   or network I/O: it is pure, synchronous and free, and a model id that has
   drifted out of `MODEL_PRICING` must fail here rather than at
   `resolveCostUsd`, which would discard an already-paid-for reply. A
   configured fallback is checked too — D5's manual-failover model is a model
   Hermes can actually call.
3. Build the JSON-line logger at the configured `LOG_LEVEL` and log the
   **redacted** config once (`toRedactedLog`) — never the raw config.
4. `createPool()` + `waitForDatabase()` — retries a trivial query before
   proceeding, since compose's healthcheck only gates container start, not
   connection readiness.
5. `runMigrations()` against `@hermes/store`'s bundled migrations directory.
6. Build the Telegram client and call `deleteWebhook()` unconditionally
   (`getUpdates` long-polling and a webhook are mutually exclusive on
   Telegram's side).
7. `acquireInstanceLock()` — a Postgres advisory lock enforcing the
   single-`getUpdates`-consumer constraint. A losing instance logs a readable
   error, releases the lock handle, sets `process.exitCode = 1`, and closes
   the pool without calling `process.exit()` (see `packages/store/README.md`).
   The poller's `onFatalError` callback (e.g. a persistent 409 conflict)
   follows the same pattern via `exitAfterFatalPollerError` — see Graceful
   shutdown below.
8. `startHealthServer()` — a `node:http` server; `GET /health` runs
   `SELECT 1` against the pool and returns
   `{ "status": "ok" | "error", "db": "connected" | "disconnected" }`
   (`200` when connected, `503` otherwise). Started only once the lock is
   held.
9. Build the Telegram adapter (`createTelegramClient` + `createTelegramPoller`)
   with its offset persisted via `@hermes/store`'s `getOffset`/`setOffset`,
   and subscribe it to a command dispatcher wrapped in `withAllowlist`
   (`src/handlers/with-allowlist.ts`) around `withPrivateChat`
   (`src/handlers/with-private-chat.ts`) — the single allowlist and
   non-private-chat gates for every handler, composed once rather than
   duplicated per handler. The dispatcher (`src/boot.ts`) routes `/ping`,
   `/start`, `/stats`, `/connect`, `/status`, and `/disconnect` to their
   handlers — each matched before the fallthrough, so an unmatched command
   can never trigger a paid completion call — and everything else to the
   completion handler (`src/handlers/complete.ts`), which now runs every
   message through the `packages/agent` (03-agent-core) loop instead of
   calling the LLM provider directly — see "Completion path" below.
10. `buildTelemetryRecorder(pool, logger)` — built after the pool because it
    writes through it, and handed to exactly two places: the handler wiring
    (which passes it into the LLM adapter as `opts.recorder`, so `llm.call`
    events are emitted from the real paid path) and `registerShutdown()`,
    where it is a **required** dep so the flush step cannot be dropped
    silently.
11. `buildRefreshSweep()` (`04-google-auth` Phase 4) — constructed and
    `start()`ed inside `wireRuntimeAndShutdown`, which only runs once
    `acquireInstanceLockOrExit` has returned a held lock — see "Google token
    refresh" below. `undefined` when Google's env group is unset, the same
    "cleanly absent" contract `buildConnectFlow` follows.
12. `registerShutdown()` — registers the SIGTERM/SIGINT handler (see below).

## Wiring modules

`boot()` has no testable seam, so each construction site that needs one is
extracted into its own small module and unit-tested there:

- `src/llm/build-provider-profiles.ts` — maps `Env`'s flat `LLM_*` fields into
  `ProviderProfile`. The one place allowed to import both `@hermes/config` and
  `@hermes/llm`.
- `src/llm/build-llm-provider.ts` — constructs the adapter, binding
  `@hermes/store`'s `recordUsage`/`sumCostSince` to the `LlmUsageRepo` and
  `BudgetUsageRepo` ports and passing the telemetry recorder through.
- `src/telemetry/build-telemetry-recorder.ts` — binds `@hermes/store`'s
  `insertEvents` to `@hermes/telemetry`'s `TelemetryEventRepo` port.
- `src/telemetry/build-stats-repo.ts` — binds `sumCostSince`,
  `getLlmCallStatsSince` and `getTopToolsSince` to the `StatsRepo` port. The
  same `sumCostSince` function goes into both this port and the budget one,
  which is what makes the cost-source split hold in practice.
- `src/store/build-thread-repo.ts` — binds `@hermes/store`'s
  `getOrCreateThread`/`appendMessages` to `@hermes/agent`'s injected
  `ThreadRepo` port (03-agent-core).
- `src/store/build-sheet-registry-repo.ts` (`05-google-sheets` Phase 4) —
  binds `@hermes/store`'s `getSheetRegistryEntryBySlug`/
  `listSheetRegistryEntries` to `@hermes/google-sheets`'s injected
  `SheetRegistryPort`, the same shape `build-thread-repo.ts` uses. No
  caching, no boot-time snapshot — every call goes straight to `pool`
  (settled decision 5).
- `src/google/build-access-token-port.ts` (`05-google-sheets` Phase 4) —
  binds `@hermes/google-sheets`'s injected `AccessTokenPort` to
  `@hermes/google-auth`'s `RefreshCoordinator.getValidAccessToken` — the
  single refresh seam `04-google-auth` Phase 4 built (see "Google token
  refresh" below), never a second refresh path (settled decision 18).
  Persists a refreshed account via the same **UPDATE-only**
  `updateRefreshedTokens` the refresh sweep uses, and only when the
  coordinator actually refreshed (a reference-inequality check against the
  account it was given) — no write-back on every tool call for an
  already-fresh token.
- `src/agent/build-agent.ts` — the only place allowed to import both
  `@hermes/agent` and construct the one hardcoded `AgentDefinition` (the D4
  multi-agent seam, reserved not built): `model` from the active provider
  profile, `systemPrompt` a fixed placeholder, `tools: [getCurrentTimeTool,
  echoTool, whoamiTool, sheetsInspectTool, sheetsReadTool, sheetsWriteTool]`,
  `channels: ["telegram"]` — reusing the exact `"telegram"` string
  `complete.ts`'s dedupe key already spells out, not a new constant. Also the
  only place that constructs the `TelegramApprovalGate` (Phase 3,
  `03-agent-core`) and wires it into the agent's deps — see "Approval gate"
  below — and (`04-google-auth` Phase 3) the `whoamiTool` itself, via
  `createWhoamiTool` closed over a `pool`-backed `buildGoogleAccountRepo`.
  `05-google-sheets` Phase 4 adds `sheetsInspectTool`/`sheetsReadTool`, built
  from `@hermes/google-sheets`'s base tool factories over a `sheetsDeps`
  object (`boot.ts` constructs it and passes it in already-built — see
  "Google Sheets tools" below) and gated the same way `whoamiTool` is,
  appended to the **end** of the tools array so the existing prefix stays
  byte-stable; Phase 5 adds `sheetsWriteTool` the same way, built over
  `{ ...sheetsDeps, sheetWriteLogRepo }` — `sheetWriteLogRepo` is a separate
  `buildAgent` parameter (not folded into `sheetsDeps`, since the read tools
  never need it), constructed inline in `boot.ts` over `@hermes/store`'s
  `claimSheetWrite`/`completeSheetWrite` — see "Google Sheets write tool"
  below. Returns `{ agent, handleApprovalCallback }`, not a bare `Agent`:
  `boot.ts` needs the latter to route inbound button taps into the gate.
- `src/google/refresh-sweep.ts` (`04-google-auth` Phase 4) — `createRefreshSweep`;
  see "Google token refresh" below.

## Completion path

`src/handlers/complete.ts`'s completion handler no longer calls
`llmProvider.complete()` directly. It claims `telegram:<updateId>` in
`llm_dedupe`, then calls the injected `Agent.handleMessage(channel, chatId,
channelUserId, text)` (built by `src/agent/build-agent.ts`, wrapping
`packages/agent`'s bounded turn loop) — `channelUserId` is the inbound
message's own sender id, threaded through so a tool handler's `ctx` can
resolve "who is asking" (`04-google-auth` Phase 3) — replies with its text,
then marks the dedupe key completed — the same load-bearing claim → reply →
complete ordering this handler has always used, unchanged. History now
persists per `(channel, chat_id)` in Postgres (`packages/store`'s `threads`
table) and survives a restart. The turn now has six tools (`get_current_time`,
`echo`, `whoami`, `sheets_inspect`, `sheets_read` — `05-google-sheets` Phase
4 — and `sheets_write` — Phase 5) and an approval gate for the two that are
gated (`echo`, `sheets_write`) — see "Approval gate" below.

### Max-iterations notice (`07-one-paid-turn-one-outcome` Phase 2)

An agent turn that exhausts `packages/agent`'s `MAX_ITERATIONS` without ever
producing a final response throws `MaxIterationsReachedError` (now exported
from `@hermes/agent`), which `complete.ts` catches by `instanceof` and
replies to with its own distinct Spanish text —
`MAX_ITERATIONS_REPLY = "Esto se alargó demasiado y no llegué a una
respuesta final. Pídemelo de nuevo, quizás en partes más chicas."` — never
`GENERIC_FAILURE_REPLY`: unlike a generic failure, this is a fully-run, paid
turn with a real (if unfinished) result to report, not an error swallowed
before it did anything.

Sending that notice goes through `sendUserNotice`, a small helper
(`complete.ts`) shared by every notice this plan adds beyond the ordinary
reply: it sends and returns `true`, or catches a delivery failure (e.g. the
user blocked the bot), logs one `logger.warn`, and returns `false` — never
throws. `replyWithCompletion` records the dedupe row `completed` **only when
`sendUserNotice` reports `delivered: true`**: an undelivered notice leaves
the row `pending`, the same "record completion only where a reply actually
reached the user" rule the ordinary happy-path send already followed. The
informational `logger.warn("agent turn reached MAX_ITERATIONS without a
final response", { channelUserId, dedupeKey, iterations, totalCostUsd })`
fires only on the delivered branch — the plan's own test spec pins exactly
one `logger.warn` per outcome — but the delivery-failure warn inside
`sendUserNotice` carries the same `iterations`/`totalCostUsd` fields (passed
in via its `context` argument), so the cost figures are never lost even when
the notice itself fails to reach the user.

### Partial-send notice (`07-one-paid-turn-one-outcome` Phase 3)

A long reply is chunked and sent as multiple Telegram messages
(`packages/channels`' `sendMessage`, `chunk.ts`). If an earlier chunk lands
but a later one fails, that's not a total failure — the user already
received real content, so `sendMessage` throws a distinguishable
`TelegramPartialSendError` (`partsSent`/`totalParts`) instead of the plain
error a first-chunk failure still throws unwrapped (zero chunks delivered
there, so the ordinary generic-failure path is correct and untouched).
`complete.ts` catches it by `instanceof` around the reply send in
`replyWithCompletion` and replies with its own distinct Spanish text —
`PARTIAL_SEND_NOTICE = "Se cortó la respuesta a la mitad. Pídemelo de nuevo,
o en partes más chicas."` — never `GENERIC_FAILURE_REPLY`.

Sending that notice reuses the same `sendUserNotice` helper the
max-iterations notice above uses, so the same rule applies: the dedupe row
is recorded `completed` with `PARTIAL_SEND_NOTICE` as the stored text only
when the notice itself is delivered; if it also fails, the row is left
`pending`, exactly one `logger.warn` fires (from `sendUserNotice`), and —
critically — the user is **not** then also sent `GENERIC_FAILURE_REPLY`,
which is what would happen if this second send fell through unguarded to
`handleCompletion`'s catch.

### Failure-notice guard, and Spanish copy (`07-one-paid-turn-one-outcome` Phase 4)

`replyWithFailureNotice` — the last-resort path `handleCompletion`'s own
catch falls into — sent `OUT_OF_BUDGET_REPLY`/`GENERIC_FAILURE_REPLY` via a
raw `channel.send()` until this phase. A blocked bot (Telegram 403) made
that send itself throw, escaping `replyWithFailureNotice` and
`handleCompletion` entirely, up to the poller's own top-level catch, which
logged a second, mislabeled error for what was really an ordinary delivery
failure. Both sends now go through the same `sendUserNotice` helper the two
notices above use — no second guard helper was added. Unlike those two,
`replyWithFailureNotice` records no dedupe completion in the first place
(the claim was never going to succeed), so `sendUserNotice`'s `boolean`
return is ignored here; its one `logger.warn` (context: `channelUserId`) is
the entire outcome of a failed delivery, and nothing escapes upward — a
fully blocked bot now costs exactly one `logger.warn` plus the one
`logger.error` `replyWithFailureNotice` already logged for the original
failure, never a second `error`.

`GENERIC_FAILURE_REPLY` and `OUT_OF_BUDGET_REPLY` are also now Spanish
tuteo, matching `EMPTY_REPLY_FALLBACK`/`MAX_ITERATIONS_REPLY`/
`PARTIAL_SEND_NOTICE`'s register:
`GENERIC_FAILURE_REPLY = "No pude procesar tu mensaje ahora. Prueba de
nuevo en un rato."`, `OUT_OF_BUDGET_REPLY = "Hermes se quedó sin
presupuesto este mes. Prueba de nuevo después del reinicio mensual."` — the
latter still never includes `capUsd`/`spentUsd`, which stay
boot-log/`/stats`-only.

## Approval gate

`echo` and `sheets_write` are the two tools this codebase ships with
`requiresApproval: true`. Before `packages/agent`'s loop runs either,
`src/agent/build-agent.ts`'s `createTelegramApprovalGate`
(`src/agent/telegram-approval-gate.ts`) sends one Telegram message per batch
of gated calls, with **Aprobar**/**Rechazar** buttons — a batch of two gated
calls in one model turn still gets exactly one combined prompt, never two.

As of `06-legible-approvals-bounded-reads`, that prompt is no longer
uniformly raw JSON. A tool can declare `ToolSpec.prepare(args, ctx)`
(`packages/agent/src/types.ts`), which the loop resolves *before* the prompt
is built and which returns either a refusal — the call resolves immediately,
no human is ever asked — or a `plan` (threaded onto the handler's `ctx.plan`)
plus an `ApprovalSummary` the prompt renders in place of raw JSON.
`sheets_write` is the one tool that declares one today; `echo` does not.

`src/agent/approval-prompt-renderer.ts` (extracted out of
`telegram-approval-gate.ts`) turns a batch into prompt text with **zero**
per-tool knowledge — every Sheets-specific word in the example below comes
from `sheets_write`'s own `prepare` (`packages/google-sheets`), not from this
renderer. A call with a usable summary renders as `action` (the question,
line 1), `target` (line 2, when present), a blank line, the preview `items`
indented two spaces plus a `…y N más (M en total).` line when `itemsTotal`
exceeds what is shown, a blank line, then one line per `effects` entry; empty
sections are dropped rather than left as dangling blank lines. A
`sheets_write` append of five rows reads:

```
¿Agregar 5 filas a clients?
Clientes activos y su contacto

  Ana Pérez, ana@example.com, 1990-05-12
  Bruno Díaz, bruno@example.com, 1988-11-03
  Carla Ruiz, carla@example.com, 1995-02-27
  …y 2 más (5 en total).

Agrega una fila nueva al final. No cambia nada de lo existente.
"1990-05-12" se guardará como fecha.
```

One row instead of five reads `¿Agregar una fila a clients?`, and `mode:
"update"` reads `¿Reemplazar una fila en clients?` / `¿Reemplazar 3 filas en
clients?` over the effect line `Sobrescribe una fila que ya existe.` — natural
Spanish agreement in both modes, never a literal `fila(s)`. The preview is
capped at the first three rows, each joined and truncated to ~100 chars with
its whitespace collapsed. The last line is the `valueInputOption` consequence
sentence, present only when the write's effective option is `USER_ENTERED`
*and* a cell looks like something Sheets would reinterpret. The A1 `range` is
deliberately never shown.

Rendering is **per call**, not per batch: a call whose `prepare` produced a
usable summary renders the block above, and a call without one — no
`prepare` at all, or a summary whose `action` came back empty — falls back to
that call's raw-JSON line, `- tool({"args":…})`. A mixed batch shows both,
one block per call separated by a blank line, so one prepare-less call never
drags the whole batch back to raw JSON. The `The model wants to run:` header
survives for exactly one case: every call in the batch falling back, where
the prompt stays byte-identical to the pre-plan format minus its trailing
"Approve or deny?" question — the Aprobar/Rechazar buttons already ask it.

Nothing `prepare` resolved beyond that summary reaches the chat. The gate
logs each ready call's raw args and its resolved `plan` (for `sheets_write`:
the `spreadsheetId` and the effective `valueInputOption`) at **debug** level
right before sending, off by default in production.

`whoami` (`04-google-auth` Phase 3) is deliberately `requiresApproval: false`
— a pure, idempotent read of the Google identity already granted at
`/connect google` time, not a consequence (`.ai/decisions/
google-oauth-flow.md`'s settled decision 3). It makes no live Google API
call: it projects `google_email` off the stored `google_accounts` row.

## Scope-gated tools (`withRequiredScopes`)

`src/agent/with-required-scopes.ts` (`05-google-sheets` Phase 2) is the one
decorator every Google-backed tool wraps its `ScopedToolSpec` in:
`withRequiredScopes(toolName, { googleAccountRepo, requiredScopes })(spec)`
returns a plain `ToolSpec` whose `handler` looks up the caller's account via
`ctx.channel`/`ctx.channelUserId` **before** the wrapped handler runs at
all — no token fetched, no API call on either failure branch (fail-closed,
ROADMAP invariant 7). No account ⇒ `{ ok: false, reason: "not_connected" }`;
connected but missing a required scope ⇒ `{ ok: false, reason:
"missing_scope", scope, fix }`, where `fix` is derived from
`requiredScopes` (`"run /connect google"` when identity alone is required,
`"run /connect google sheets"` when a Sheets scope is) rather than hardcoded
to Sheets — a tool gating on identity alone gets the right instruction, not
a Sheets-flavored one. Otherwise the account is fetched exactly **once**:
it's threaded into the wrapped handler via `ctx.googleAccount`
(`ScopedToolContext = ToolContext & { googleAccount }`) rather than making
the wrapped handler re-fetch it, so a scoped tool never issues two
`getAccount` calls per invocation. `spec.handler`'s result otherwise passes
through unchanged.

As of `06-legible-approvals-bounded-reads`, the decorator wraps a declared
`prepare` the same way it wraps `handler` (`ScopedToolSpec<P>` mirrors
`ToolSpec<P>`'s plan type; the shared `checkScopeGate` helper is what keeps
the two wraps from duplicating the decision, and each invocation still costs
exactly one `getAccount`). The refusal shapes are identical, just reachable
one step earlier — wrapped in `{ ok: false, result }`, since that is what
`ToolPreparation` calls a refusal — so an unconnected or under-scoped user is
never shown an approval prompt for a call already destined to fail. The
`prepare` slot is forwarded via conditional spread, so a `ScopedToolSpec`
without one still produces a `ToolSpec` without one. Both failure
shapes are structured results, not thrown errors, so the model relays
them as chat text. `toolName` is asserted
against the wrapped spec's own `name` at decoration time — a mismatch
(wiring `requiredScopes` to the wrong tool) throws immediately rather than
silently gating the wrong tool.

`ScopedToolSpec`'s `handler` type (`(args, ctx: ScopedToolContext) =>
Promise<unknown>`) is never assignable to a bare `ToolSpec.handler` slot —
`packages/agent`'s `ToolContext` is unchanged by this decorator, and the
extension lives entirely in this file, matching the D4 boundary
(`packages/agent` never imports `@hermes/google-auth`). `withRequiredScopes`
is the only bridge between the two: it builds the extended ctx itself and
calls the scoped handler with it directly, never via a cast. See
`packages/agent/README.md`'s Port contract section for the `ctx` contract
this relies on.

`whoami` is refactored onto this decorator
(`withRequiredScopes("whoami", { googleAccountRepo, requiredScopes:
IDENTITY_SCOPES })`) to prove the pattern against a tool that already
works, before the Sheets tools (Phase 4/5) lean on it for their own gating —
`whoami`'s own handler now assumes an already-verified, already-connected
account (read off `ctx.googleAccount`, never re-fetched) and just projects
the email. `TOOL_REQUIRED_SCOPES` (`@hermes/google-auth`) is a tool name →
required scopes reference map; `withRequiredScopes` call sites pass
`requiredScopes` explicitly rather than looking it up, so the map stays
documentation until a future phase decides to make it authoritative.
`ScopedToolSpec` also carries `timeoutMs?: number`, forwarded verbatim onto
the gated `ToolSpec` by `decorate()` — a scoped tool's `ToolSpec.timeoutMs`
survives gating unchanged.

- **In-memory only, never persisted.** A pending approval lives in a
  `Map<approvalId, ...>` inside the gate's closure. Restarting the process
  drops it — there is no recovery path, by design (settled decision 6): a
  restarted bot's next `callback_query` against a now-unknown id gets the
  same "this approval has expired, please ask again" reply as an
  already-resolved or genuinely-unknown one. All three are the same code
  path, never a hang, a throw, or a second tool execution.
- **One resolution, three possible triggers.** A tap (routed through
  `boot.ts`'s `channel.subscribeCallback` wiring, alongside — not instead of
  — the existing message dispatch), a 5-minute timeout, or the turn's own
  `AbortSignal` firing. Whichever happens first synchronously deletes the
  pending entry before any `await` (including the `editMessage` that shows
  the resolved state), so the other two triggers can never also resolve the
  same approval — a stale callback arriving right after the timer fires still
  gets the expiry reply, never a second resolution.
- **Denied, timed out, or aborted mid-wait are one outcome.** Each gated call
  becomes a `"user did not approve"` tool result and the turn *continues* so
  the model can respond to the denial — only the iteration cap, an abort, or
  an LLM-level failure actually end a turn.
- **Ungated calls in the same batch are never blocked** by the approval wait
  (settled decision 16) — `get_current_time` alongside a gated `echo` call in
  the same model response still resolves immediately.
- `build-agent.ts` resolves a turn's `threadId` to its Telegram chat id via a
  small in-memory index populated as threads are loaded (`ApprovalGate`'s
  port is channel-agnostic — its context deliberately carries no chat id).

## Google token refresh

`04-google-auth` Phase 4 adds a boot-owned background sweep that keeps
connected accounts' access tokens fresh without any request-path call ever
needing to trigger a refresh itself.

- **One seam, two callers.** `@hermes/google-auth`'s `createRefreshCoordinator`
  exposes exactly one public entry point, `getValidAccessToken(account)`: a
  fresh account (`expiresAt` well outside `REFRESH_SKEW_MS`, 10 minutes)
  returns the cached token with zero network calls; a stale one refreshes
  through a single-flight `Map` keyed on `(channel, channelUserId)`, entry
  deleted in a `finally` so a failed refresh never poisons a later,
  independent attempt. `src/google/refresh-sweep.ts`'s `createRefreshSweep`
  is the only caller today, and any future request-path tool needing a live
  Google client would call the exact same function — never a second "force
  refresh" path.
- **`buildRefreshSweep` (`src/boot.ts`)** builds the coordinator — passing
  `createGoogleRefreshAccessToken(oauthClient)` as its **required**
  `RefreshAccessTokenPort`, since the coordinator itself never imports
  `google-auth-library` — plus a
  narrow `RefreshSweepRepo` (`listAccountsExpiringBefore`/
  `updateRefreshedTokens`/`markDisconnected`, bound to `@hermes/store`'s
  pool-taking functions — the write is UPDATE-only, never `upsertAccount`, so
  a refresh can never re-create a row `/disconnect` just deleted) and
  returns `undefined` when Google's env group is unset — the same "cleanly
  absent, not a boot failure" contract `buildConnectFlow` follows.
- **Construction is gated by the single-instance advisory lock, by
  inspection, not by convention.** `wireRuntimeAndShutdown` — where
  `buildRefreshSweep(...).start(...)` runs — is only ever called from
  `boot()` after `acquireInstanceLockOrExit` has returned a held lock (`boot()`
  returns early otherwise); the single-flight map's correctness depends on
  exactly one Hermes process running against a database, the same invariant
  the advisory lock (`packages/store/src/advisory-lock.ts`) already
  enforces. There is no standalone script or bin entry for the sweep — it is
  reachable only from `boot()`.
- **`runOnce()` runs immediately inside `start()`**, then on
  `REFRESH_SWEEP_INTERVAL_MS` (5 minutes — deliberately half of
  `REFRESH_SKEW_MS`, so one missed or slow tick still leaves a full interval
  of buffer before a token actually expires). This immediacy is what makes
  "a token forced expired via `psql` before a restart gets refreshed within
  one sweep pass" true without waiting out a full interval.
- **Failure classification.** `RefreshFailedError`'s `reason: "invalid_grant"`
  (Google reports the refresh token revoked/expired, or the stored envelope
  fails to decrypt) calls `markDisconnected` — the same `DELETE` `/disconnect`
  uses, so `whoami`/`/status` land on the identical "not connected" path with
  no separate disconnected-but-present state — then sends a reconnect prompt
  to `account.chatId`. The disconnect is logged (warn, with
  channel/channelUserId/reason) before the mutation, since it needs human
  action. `reason: "transient"` (network failure, a Google 5xx) is logged and
  the row is left untouched for the next tick; zero expiring accounts is a
  no-op.
- **Per-account isolation.** Failure handling is wrapped inside
  `refreshOneAccount`, and the reconnect alert is isolated from
  `markDisconnected`, so a blocked bot (Telegram 403) or any other throwing
  alert/handler is logged rather than unwinding `runOnce`'s loop and skipping
  every remaining account in the tick.
- **No overlapping ticks.** A tick that fires while the previous `runOnce()`
  is still in flight is skipped and logged — which is also what keeps
  `stop()` honest, since it awaits the single in-flight run rather than
  whichever tick started last.
- **Shutdown**: `sweep.stop()` clears the interval and awaits any in-flight
  `runOnce()` call, bounded by `SWEEP_STOP_TIMEOUT_MS` (1s, see "Graceful
  shutdown" below) so a stuck refresh mid-tick can't stall the rest of
  shutdown — it degrades to "pick up where it left off on the next boot's
  immediate sweep pass," the same tradeoff the telemetry flush accepts.

See `.ai/decisions/google-token-refresh.md` for the full design and its
dependency on the advisory lock.

## Google Sheets tools (`05-google-sheets` Phase 4)

`sheets_inspect { sheet }` and `sheets_read { sheet, range,
valueRenderOption? }` — the first two real Google-backed capabilities, over
`@hermes/google-sheets`'s generic (non-trading) read tools. Both are gated
behind `withRequiredScopes(name, { googleAccountRepo, requiredScopes:
SHEETS_SCOPES })`, the same pattern `whoami` uses (see "Scope-gated tools"
above): **fail-closed** — an identity-only account, or no account at all,
never reaches the Sheets tool's own handler, never fetches an access token,
never calls the Sheets API. The model relays `{ ok: false, reason:
"not_connected" }`/`{ ok: false, reason: "missing_scope", fix: "run
/connect google sheets" }` as a plain-language "run /connect google sheets"
message.

- **`sheet` is always a registered slug, never a raw spreadsheet ID/URL
  typed in chat.** `@hermes/google-sheets`'s `resolveSheet` looks the slug
  up against the *live* registry (`SheetRegistryPort`, bound in
  `src/store/build-sheet-registry-repo.ts` — no caching, so a slug
  registered via `hermes-sheets add` mid-conversation is usable on the very
  next tool call). An unknown slug — including an entirely empty registry —
  returns `{ ok: false, reason: "unknown_sheet", available: string[] }`
  (`available: []` when nothing is registered yet), which the model relays
  listing the real registered slugs instead of a bare refusal.
- **The access token comes from the existing refresh seam, never a second
  one.** `src/google/build-access-token-port.ts` binds `AccessTokenPort` to
  `RefreshCoordinator.getValidAccessToken` — see "Google token refresh"
  above and settled decision 18. A Sheets tool call never triggers its own
  independent OAuth refresh logic.
- **Both tools set `ToolSpec.timeoutMs: 30_000`** (`packages/agent`, this
  phase) — a real Sheets API call, including `@hermes/google-sheets`'s own
  internal retries, can outrun the 10s default meant for local computation.
  `withRequiredScopes` forwards `timeoutMs` onto the gated `ToolSpec` (see
  "Scope-gated tools" above), so this budget survives gating unchanged.
- **`sheets_read` permits any registered `access` value** (`read` or
  `readwrite`) — only `sheets_write` (Phase 5) checks `access`, and only
  that tool requires human approval; both Phase 4 tools are
  `requiresApproval: false`, the same posture `whoami` has (a read has no
  consequence to confirm).

## Google Sheets write tool (`05-google-sheets` Phase 5)

`sheets_write { mode: "append" | "update", sheet, range, values,
valueInputOption? }` — the one write-capable tool, gated the same way the
read tools are (`withRequiredScopes("sheets_write", ...)`, see "Google
Sheets tools" above) **and** behind the approval gate (`requiresApproval:
true`, see "Approval gate" above). Full design lives in
`@hermes/google-sheets`'s own README; this section covers only what's wired
here in `apps/hermes`.

- **Access enforcement runs before the approval prompt, let alone any dedupe
  claim or API call.** As of `06-legible-approvals-bounded-reads` Phase 4
  both of `resolveSheet`'s failure modes live in `sheets_write`'s `prepare`:
  an unknown slug (`{ok: false, reason: "unknown_sheet", available}`) and a
  sheet registered `read` (`{ok: false, reason: "read_only_sheet"}`) are
  refused before a human is asked anything, before `sheet_write_log` is ever
  touched, and before an access token is ever fetched — proved by
  `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts`
  asserting zero calls to the dedupe port and the Sheets client on that
  path.
- **`sheetWriteLogRepo` is wired inline in `boot.ts`** (`buildSheetWriteLogRepo`),
  over `@hermes/store`'s `claimSheetWrite`/`completeSheetWrite` — the same
  inline-object-over-`pool` shape `createMessageHandlers`'s `dedupeRepo`
  already uses for `llm_dedupe`, not a new `src/store/build-*.ts` file (this
  port has exactly one caller). It backs the claim/complete idempotency key
  over `(channel, channelUserId, turnId, tool, canonical args)` — a same-turn
  model retry with identical args never calls the Sheets API twice; a later,
  genuinely repeated request (a different turn) does call it again. This
  table is also the durable write audit invariant 3 needs, since
  `telemetry_events` is buffered and at-most-once.
- **`TOOL_REQUIRED_SCOPES` gains `sheets_write` -> `SHEETS_SCOPES`**
  (`@hermes/google-auth`), the same reference-map entry `sheets_inspect`/
  `sheets_read` already have — still documentation, not consulted at gate
  time (see "Scope-gated tools" above).
- **Manual verification** (no live-provider test lane changes — same posture
  Phase 4 took): ask the bot to add a row to a `readwrite`-registered sheet,
  approve the prompt, confirm the row lands; repeat the same request in the
  same turn (a model retry or re-approve) and confirm no duplicate row and
  exactly one `sheet_write_log` row for that key (`psql`); attempt a write
  against a `read`-registered sheet and confirm the refusal with no new
  `sheet_write_log` row.

## Handlers

- `complete.ts` — the dispatcher's fallthrough and the only handler that
  spends money. Claims `telegram:<updateId>` in `llm_dedupe` before the
  agent turn and marks it completed after the reply lands. Since
  `07-one-paid-turn-one-outcome` it sends distinct Spanish copy for a
  partial send (`TelegramPartialSendError`, an earlier chunk landed) and for
  a max-iterations stop (`MaxIterationsReachedError`), routes every notice
  send through one `sendUserNotice` guard so a user who blocked the bot
  produces a single `warn` instead of an escaped, mislabeled error, and
  records dedupe completion only when a reply actually reached the user.
- `connect.ts` — `/connect google` requests `IDENTITY_SCOPES`; `/connect
  google sheets` (`05-google-sheets` Phase 2, case-insensitive, whitespace
  trimmed) requests identity plus `SHEETS_SCOPES`. Both forms and the
  malformed-argument fallback resolve through `@hermes/google-auth`'s
  `resolveConnectScopes`, which returns `undefined` for anything else so the
  handler falls back to its usage-help message rather than requesting the
  wrong scopes. The resolved list is passed straight into
  `connectFlow.startConnect`; the OAuth callback route
  (`src/google/build-oauth-callback-route.ts`) is what later calls
  `completeConnect` and notifies the chat. A full grant sends "Connected as
  `<email>`." unchanged from `04-google-auth`. A partial grant
  (`completeConnect`'s result carries `missingScopes` — identity connected,
  Sheets wasn't) sends a distinct message instead: "Connected as `<email>`.
  Sheets access wasn't granted — run /connect google sheets again and
  approve the Sheets permission to enable it." Either way the account is
  already persisted by the time this message is sent — `completeConnect`
  only reaches `ok: true` (full or partial) after `persistAccount` runs.
- `disconnect.ts` (`04-google-auth` Phase 3; revoke added `05-google-sheets`
  Phase 6) — `/disconnect` first attempts to revoke the OAuth grant at
  Google (best-effort — decrypts the stored refresh token and calls
  `@hermes/google-auth`'s `revokeToken`, which never throws), then removes
  the sender's `google_accounts` row and confirms. Idempotent by
  construction: `deleteAccount` is a plain `DELETE ... WHERE`, so a second
  call against an already-disconnected chat finds no account to revoke,
  affects zero rows, and still replies the same confirming text, never a
  throw. The decrypt capability (`MessageHandlerDeps.decryptRefreshToken`,
  built by `boot.ts`'s `buildDecryptRefreshToken`) is injected narrowly —
  only `disconnect.ts` receives it, rather than threading the raw
  `cryptoKey` through every handler. See
  `packages/google-auth/README.md`'s "Revoke" section for the full design.
- `echo.ts` — echoes back the message text. **No longer wired**; kept in the
  tree as a documented reference/fallback after `complete.ts` took its place
  as the fallthrough.
- `ping.ts` — `/ping` replies with process uptime and DB status, reusing
  `health.ts`'s `checkDbConnectivity` rather than duplicating the check.
- `start.ts` — `/start` confirms allowlist membership (implicit — reaching
  the handler already proves it) and DB connectivity, via the same check.
- `stats.ts` — `/stats` replies with spend today/this month vs. the
  configured cap, calls, total input/output tokens, cache-hit rate, error
  rate, and a top-tools-this-month list (`"no tool calls recorded yet"` until
  `packages/agent`, 2c, produces `tool.call` events). Thin wiring only: the
  math is `@hermes/telemetry`'s `computeStats`, the rendering its
  `formatStatsMessage`. Spend/cap figures come from `@hermes/store`'s
  `sumCostSince` against `llm_usage` — the same function the budget ceiling
  reads — while calls/tokens/rates/top-tools come from `telemetry_events`
  instead, so `/stats` can never disagree with the ceiling it reports
  against. "Error rate" means precisely the share of `llm.call` events with
  `is_error = true`; a budget-ceiling rejection never produces an `llm.call`
  event, so it is excluded by construction, not by a filter.
- `status.ts` (`04-google-auth` Phase 3) — `/status` reads the sender's
  `google_accounts` row and replies "Connected as `<email>`, scopes:
  `<scopes>`" or "Not connected. Run /connect google to connect." Reads
  `scopes` from the stored row (what was actually granted), never from
  `TOOL_REQUIRED_SCOPES` (what a given tool requires). No LLM call either
  way, mirroring `stats.ts`'s shape.
- `with-allowlist.ts` — `withAllowlist(handler, allowlist, logger)`, composed
  once in `boot.ts` around the dispatcher rather than inlined in each
  handler.
- `with-private-chat.ts` — `withPrivateChat(handler, logger)`, composed once
  in `boot.ts` inside `withAllowlist`, rejects any non-private chat — even
  from an allowlisted sender — before it reaches the dispatcher, since a
  group reply would broadcast to everyone in it.

## Graceful shutdown

`boot.ts` registers a single SIGTERM/SIGINT handler that runs, in this exact
order:

1. `controller.abort()` — the boot-lifetime `AbortController`, fired first and
   before anything is awaited. Its signal is threaded into the poller's
   in-flight `getUpdates` call (see
   `packages/channels/src/telegram/{client,poller}.ts`), so the drain below
   resolves as soon as the abort lands on an idle bot instead of always
   burning its full bound. `controller` is a required `ShutdownDeps` field,
   not optional.
2. `channel.stop()` — flips the poller's `stopping` flag so no new
   `getUpdates` call starts, awaits any in-flight `callback_query` handler
   (still processed inline), then drains every message dispatch left
   detached from the poll loop (see `packages/channels/README.md`'s "Offset
   persistence and the idempotency contract" — a message handler is no
   longer awaited by the loop itself, only by this drain). Bounded to ~5s
   (`DRAIN_TIMEOUT_MS`) regardless of the abort, so a genuinely stuck drain
   still can't block the rest of shutdown indefinitely; a message dispatch
   still running past that bound is abandoned when the process exits.
3. `telemetryRecorder.stop()` — flushes any buffered `llm.call` events.
   Bounded independently to ~1s (`TELEMETRY_FLUSH_TIMEOUT_MS`) so a hung
   flush degrades to "lose the unflushed buffer" instead of stalling the
   rest of shutdown. Runs after the drain (so it can capture events from the
   in-flight work that just finished) and before the pool closes (so its own
   write still has a live pool to go through).
4. `sweep.stop()` (`04-google-auth` Phase 4) — clears the refresh sweep's
   interval and awaits any in-flight `runOnce()` call. Bounded independently
   to ~1s (`SWEEP_STOP_TIMEOUT_MS`) so a hung refresh mid-tick degrades to
   "pick up where it left off on the next boot's immediate sweep pass"
   instead of stalling the rest of shutdown. Must still run before the lock
   releases/pool closes below — an in-flight tick is still issuing DB
   queries. When Google's env group is unset, `boot()` wires a trivial
   `{ stop: async () => {} }` here — the sweep never started, so there's
   nothing to stop.
5. The advisory lock's `release()` — only once no more DB work from this
   instance is possible, so a restart-racing second instance can't acquire
   the lock while this one is still draining.
6. `pool.end()`.
7. `process.exit(0)`, after a tick (`setImmediate`) to let the final log line
   flush before the async stdout write is truncated.

A hard-exit fallback timer (`HARD_EXIT_TIMEOUT_MS`, ~8s) forces
`process.exit(1)` if any step hangs past it — comfortably under
`docker-compose.yml`'s explicit `stop_grace_period: 15s` for this service,
so a stuck shutdown gets killed by the app's own fallback before Docker
sends `SIGKILL`. (`stop_grace_period` must stay above `HARD_EXIT_TIMEOUT_MS`,
which must stay above `DRAIN_TIMEOUT_MS + TELEMETRY_FLUSH_TIMEOUT_MS +
SWEEP_STOP_TIMEOUT_MS` with room left for `release()`/`pool.end()` — don't
change one without the others.) The sequence is exported as `shutdown()`
from `boot.ts` for unit testing: `src/__tests__/shutdown-order.test.ts` pins
the step order, `src/__tests__/shutdown-abort.test.ts` pins the abort-first
step and the telemetry flush's and refresh sweep's own time boxes.

The poller's `onFatalError` callback (a persistent 409 conflict — another
instance already holds the `getUpdates` stream) is a separate, unbounded exit
path: `exitAfterFatalPollerError` logs the error, sets `process.exitCode = 1`
and awaits `pool.end()`, without calling `process.exit()` directly, for the
same log-flush reason as the advisory-lock path above.
