# @hermes/channels

Chat channel adapters. Phase 2 ships one: Telegram, long-polled. Phase 4 adds
message chunking, structured retry/backoff, and graceful drain.

## `Channel` port contract

`src/channel.ts` defines the provider-neutral surface every adapter
implements:

- `capabilities: { markdown, files, buttons, maxMessageLength }` — static
  flags a handler can use to decide what it's allowed to send (e.g. whether
  to bother formatting Markdown).
- `subscribe(handler)` — registers the single `InboundMessageHandler`
  invoked for every inbound message, already normalized into `InboundMessage
  { channelUserId, chatId, text, chatType, kind, updateId }`. Handlers never
  see raw Telegram (or any other platform's) wire format.
  `updateId` (required, added in Phase 5) carries the platform's own update id
  (Telegram's `update_id`); it exists specifically so a handler with an
  external, paid side effect can derive a stable dedupe key
  (`apps/hermes/src/handlers/complete.ts` derives
  `telegram:<updateId>` and claims it via `@hermes/store`'s `llm_dedupe`
  table before calling the LLM provider — see
  `packages/store/README.md`). It's optional so it has no effect on handlers
  built before this phase: echo/`/ping`/`/start` simply ignore the field,
  still safe by inspection (see "Guards" below) since none of them has an
  external side effect requiring a dedupe key.
- `send(target, text, options?)` — replies into `target` (the
  channel-specific chat id, e.g. `InboundMessage.chatId`). Returns the sent
  message's id: `Promise<{ messageId: string }>`. `options.buttons` (rows of
  `{ label, callbackData }`, Phase 3) attaches an inline keyboard — only
  meaningful on a channel whose `capabilities.buttons` is true. Additive over
  the pre-Phase-3 shape: a caller that passes no `options` and ignores the
  return value is unaffected. `send` can throw a plain error (total
  failure — nothing delivered) or, for the Telegram implementation
  specifically, `TelegramPartialSendError` when an earlier chunk of a
  multi-part message already landed before a later one failed — callers that
  care about the distinction should check `instanceof
  TelegramPartialSendError` (`07-one-paid-turn-one-outcome` Phase 3).
- `subscribeCallback(handler)`, `editMessage(target, messageId, text)`,
  `answerCallback(callbackId, text?)` (Phase 3, all optional on the `Channel`
  port) — the inline-keyboard surface `apps/hermes/src/agent/
  telegram-approval-gate.ts` uses: `subscribeCallback` registers the single
  handler invoked for every inbound button tap, normalized into
  `InboundCallback { callbackId, callbackData, chatId, messageId,
  channelUserId }`; `editMessage` edits a previously sent message in place
  (used to make a resolved approval prompt's buttons inert); `answerCallback`
  acknowledges a tap (Telegram requires every `callback_query` to be
  answered). Optional on the base port so a `Channel` mock built before
  inline keyboards existed is unaffected — `TelegramPoller` (below) narrows
  all three to required, since the real Telegram implementation always
  provides them.

Business logic — the private-chat-only guard, command dispatch, echoing —
lives in `apps/hermes/src/handlers/`, not in this package. Allowlist
enforcement (`isAllowed`) lives here as a pure function, but is composed once
around the dispatcher in `apps/hermes/src/boot.ts` (`withAllowlist`), not
inside individual handlers. This package's job stops at "reliably move
messages in and out of Telegram."

## Telegram adapter

- `telegram/client.ts` — a raw-`fetch` wrapper around `getUpdates`,
  `sendMessage`, `answerCallbackQuery`, and `editMessageText` (the last two,
  Phase 3). Still no telegraf/grammy: four endpoints don't justify a
  mega-package. `sendMessage` chunks its text via `chunk.ts` before sending,
  awaiting each part in order, and returns the last part's `message_id`; an
  optional `options.replyMarkup` (an inline keyboard) is attached only to
  that last part, so a keyboard never appears mid-message on a long send.
  `getUpdates`, `sendMessage`, `answerCallbackQuery`, and `editMessageText`
  all route errors through `@hermes/core`'s shared `withHttpRetry` helper
  (also used by `packages/llm`'s adapter) via three named retry classes this
  package alone defines: `rateLimit` (HTTP 429, `maxAttempts: 5`) waits for
  Telegram's `retry_after` (falling back to computed backoff if absent);
  `conflict` (HTTP 409 — another `getUpdates` consumer already running,
  `maxAttempts: 3`) gets a few bounded retries then rethrows with its own
  readable exhausted-retries message, since that's a real conflict, not a
  blip; `transient` (5xx and network/timeout errors, `maxAttempts: 5`) backs
  off exponentially, bounded, then rethrows to the poller's own retry loop.
  Retries reuse the exact same request body, so a retried `getUpdates` call
  keeps the same offset automatically. `@hermes/core`'s helper owns the
  timeout/signal composition and per-class attempt bookkeeping; this
  package's own `classify`/token-redaction stay exactly as before.
- `telegram/chunk.ts` — `chunkText(text, maxLen = 4096): string[]`, a pure
  boundary chunker: splits at the last whitespace before `maxLen`, hard-cuts
  only when no whitespace exists in range. Concatenating the returned parts
  always reproduces the original text exactly. Deliberately **not**
  markdown-entity-aware — nothing in this PRD sets `parse_mode` yet, so
  entity-safe splitting has no caller; it arrives with a future
  Markdown-formatted output layer.
- `@hermes/core`'s `nextDelay(attempt, retryAfterHeader?): number` — pure and
  clock-independent (callers pass the attempt count directly). Exponential
  growth from a fixed base, capped, with uniform jitter to avoid synchronized
  retries; `retryAfterHeader` always overrides the computed value when
  present. Promoted out of this package (formerly `telegram/backoff.ts`) so
  `packages/llm`'s adapter can share the same implementation instead of
  duplicating it. `@hermes/core`'s `withHttpRetry` (see that package's
  README) now wraps `nextDelay`/`delay` with the full retry-loop, timeout,
  and signal-composition mechanics on top — this client supplies only its
  own `classify` and the three named classes above.
- `telegram/poller.ts` — the long-poll loop (`timeout=30s`, `limit=100`,
  `allowed_updates=["message","edited_message","callback_query"]`, the last
  added Phase 3) plus `normalizeTelegramUpdate`, which converts a raw update
  into an `InboundMessage` or returns `null` when it can't (see guards
  below), populating `updateId` from the raw update's own `update_id`. Phase
  3 adds `normalizeTelegramCallback`, the same shape for a `callback_query`
  update: `null` when there's no `callback_query`, or one missing its
  `message`/`data` (fail-closed, logged at debug, mirroring
  `normalizeTelegramUpdate`'s own guard); otherwise an `InboundCallback`
  dispatched to the single handler `subscribeCallback` registers — a raw
  update is either a message or a `callback_query`, never both, so only one
  handler ever fires per update. The offset is loaded once at start via a
  `TelegramOffsetRepo` port (injected — `boot.ts` wires it to
  `@hermes/store`'s `getOffset`/`setOffset`, keeping this package decoupled
  from Postgres). **A `callback_query` is awaited inline** by the poll loop
  and its offset persisted only once its handler completes — see "Offset
  persistence and the idempotency contract" below for why, and why **a
  message update is not**: it's dispatched without the loop waiting on it,
  and its offset advances immediately. `TelegramPollerOptions.retryDelayMs`
  overrides the fixed delay used after a transient failure (tests inject a
  short value instead of waiting out the real one). `createTelegramPoller`
  returns a `TelegramPoller` — a `Channel` plus `stop(): Promise<void>`,
  which flips a `stopping` flag read by the loop's condition (so no new
  `getUpdates` call starts), resolves once the loop has actually exited
  (in-flight `callback_query` handler included), and then drains every
  message dispatch still detached from that last iteration before settling.
  In the normal shutdown path, `boot.ts` aborts the shared
  `TelegramPollerOptions.signal` before calling `stop()`, which aborts the
  in-flight `getUpdates` call immediately (see `client.ts`'s abort handling);
  the loop detects this and exits on that same iteration, logging `"poll
  aborted for shutdown"` at info rather than the transient-failure retry
  warning. See `apps/hermes/src/boot.ts`'s shutdown sequence for how this is
  bounded by a timeout.
- `telegram/allowlist.ts` — `parseAllowlist(csv): Set<number>` and
  `isAllowed(id, set)`, both pure. An empty allowlist rejects everyone
  (fail closed).

### Token redaction

Telegram embeds the bot token in the URL *path*
(`https://api.telegram.org/bot<token>/<method>`), not in an `Authorization`
header, so nothing redacts it automatically the way it would with a header.
`client.ts` redacts the token out of every thrown error's message — HTTP
error responses, Telegram `ok: false` responses, and network failures alike
— by string-replacing the raw token with `<REDACTED>` before the error ever
leaves this module. This holds on the network-failure path too, where the
raw URL most often leaks via the underlying fetch error's message.

The client-side `AbortController` timeout for `getUpdates` is the poll
`timeout` param **plus a fixed 10s margin**, not equal to it — Telegram
legitimately holds the connection open for up to `timeout` seconds waiting
for a message, so a client timeout at or below that value aborts requests
that were never actually stuck, causing reconnect storms.

### Guards (fail closed)

- **No `message.from`**: some updates (channel posts, anonymous-admin group
  messages) carry no sender id. There's nothing to check against the
  allowlist, so `normalizeTelegramUpdate` drops these before an
  `InboundMessage` is ever constructed — logged at debug, since it's
  expected background noise, not actionable.
- **Non-private chat**: Hermes is a single-user assistant (no multi-user
  support). `withPrivateChat` (`apps/hermes/src/handlers/with-private-chat.ts`),
  composed once around the command dispatcher in `boot.ts`, rejects any
  message whose `chatType !== "private"`, logged at warn, **even from an
  allowlisted sender** — replying into a group broadcasts the reply to
  everyone in it, which is never the intent for a personal assistant bot.
- **Unknown sender**: `withAllowlist` (`apps/hermes/src/handlers/with-allowlist.ts`),
  composed once around the command dispatcher in `boot.ts`, rejects any
  sender not in the allowlist before any handler (`echo`, `/ping`, `/start`)
  ever runs — a single gate instead of each handler re-implementing the
  check.

### Offset persistence and the idempotency contract

**For a `callback_query` update**, the poller persists `update_id + 1`
**after** its handler is fully awaited — never before, and never batched
across a whole `getUpdates` response. This ordering is load-bearing:
Telegram permanently deletes an update once its `update_id` has been acked
via `offset` on a later `getUpdates` call, so persisting earlier risks
losing that update forever if the process crashes mid-handling.

This creates an explicit contract for callbacks: **a crash between "handler
completed" and "offset persisted" replays exactly the one in-flight callback
on restart.** `poller-crash-replay.test.ts` simulates this concretely —
persistence fails once, a fresh poller instance is built against the same
(unchanged) persisted offset, and the same `callback_query` is shown to be
re-delivered and re-handled.

**For a message update, this guarantee was deliberately narrowed away in
Phase 3.** The poll loop no longer awaits a message handler before looping
back to the next `getUpdates` call — a completion handler can be blocked for
minutes awaiting a Telegram approval tap (`apps/hermes/src/agent/
telegram-approval-gate.ts`), and awaiting it inline meant `getUpdates` never
ran again to fetch the very `callback_query` that would unblock it,
deadlocking the bot on every gated tool call. Instead, a message is
dispatched without the loop waiting on it, and **its offset advances
immediately**, before its handler has even started. The accepted trade-off:
**a message update in flight when the process dies is not redelivered on
restart** — the crash-replay guarantee above now applies only to
`callback_query`. `poller-crash-replay.test.ts` also pins this narrower
message-side behavior directly (offset advances while the handler is still
pending). A message handler that throws is also no longer retried by
redelivery: it's logged loudly (`"message handler failed after its offset
was already advanced, not retried"`) instead, since there is no redelivery
left to fall back on for that update.

**A `setOffset` failure itself is a narrower, different case.** For a
message update, `offsetRepo.setOffset` is now called — and awaited —
*before* `dispatchMessage` even starts, not after. If it rejects, the
handler is never invoked at all: the update was never acked, so it is
cleanly redelivered on the next `getUpdates` call and runs exactly once,
with no double-charge risk. This is narrower than, not identical to, "there
is no redelivery to fall back on" above — that line describes an ordinary
handler failure *after* a successful ack, which still stands unchanged.

The echo handler is safe under (callback) replay and under a lost message by
inspection: send-and-reply has no side effect beyond, at most, a missing or
duplicate user-visible message, so there is no dedupe key here. **Any future
handler with an external side effect** (e.g. a later `log_trade`-style
handler) **must add its own idempotency key**, since neither "replayed" nor
"silently dropped" can be assumed away by this package — this phase solves
safety only for echo, not generally.

The completion handler (`apps/hermes/src/handlers/complete.ts`, added
02-llm-port) is the first handler with such a side effect — a real, paid LLM
call — and it closes the redelivery-side (duplicate) half of this gap using
`InboundMessage.updateId`: see the field's own doc comment on `channel.ts`
and `packages/store/README.md`'s `llm_dedupe` section for the deterministic
exact-duplicate proof and the narrower, accepted claim-to-complete
crash-window risk. It does not (and cannot) recover a message whose handler
never ran at all because the process died mid-dispatch — that is the
explicit trade-off this section documents, accepted so the approval gate
never deadlocks the poller.

### Single-instance constraint

Telegram allows exactly one `getUpdates` consumer per bot token. Hermes
enforces this with a Postgres advisory lock acquired in `boot.ts` before the
poller starts (see `packages/store/README.md`'s Single-instance advisory
lock section) — a second instance against the same database fails fast at
boot with a readable error instead of a `getUpdates` 409 surfacing later
mid-poll.

### Deliberately deferred

- **Markdown-entity-aware chunking**: `chunk.ts` splits on whitespace only.
  Splitting without corrupting Markdown entities (bold/italic/code spans)
  only matters once Markdown-formatted output exists (`parse_mode` in use),
  which arrives with a future formatting/agent layer — building it now would
  be machinery with no caller, per the project's "no speculative
  abstractions" principle.
