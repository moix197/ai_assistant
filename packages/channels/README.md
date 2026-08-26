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
  { channelUserId, chatId, text, chatType, kind }`. Handlers never see raw
  Telegram (or any other platform's) wire format.
- `send(target, text)` — replies into `target` (the channel-specific chat
  id, e.g. `InboundMessage.chatId`).

Business logic — the private-chat-only guard, command dispatch, echoing —
lives in `apps/hermes/src/handlers/`, not in this package. Allowlist
enforcement (`isAllowed`) lives here as a pure function, but is composed once
around the dispatcher in `apps/hermes/src/boot.ts` (`withAllowlist`), not
inside individual handlers. This package's job stops at "reliably move
messages in and out of Telegram."

## Telegram adapter

- `telegram/client.ts` — a raw-`fetch` wrapper around `getUpdates` and
  `sendMessage`. No telegraf/grammy: two endpoints don't justify a
  mega-package. `sendMessage` chunks its text via `chunk.ts` before sending,
  awaiting each part in order. Both `getUpdates` and `sendMessage` route
  errors through the retry policy in `backoff.ts`: a `429` waits for
  Telegram's `retry_after` (falling back to computed backoff if absent); a
  `409` (another `getUpdates` consumer already running) gets a few bounded
  retries then rethrows, since that's a real conflict, not a blip; `5xx` and
  network/timeout errors back off exponentially, bounded, then rethrow to the
  poller's own retry loop. Retries reuse the exact same request body, so a
  retried `getUpdates` call keeps the same offset automatically.
- `telegram/chunk.ts` — `chunkText(text, maxLen = 4096): string[]`, a pure
  boundary chunker: splits at the last whitespace before `maxLen`, hard-cuts
  only when no whitespace exists in range. Concatenating the returned parts
  always reproduces the original text exactly. Deliberately **not**
  markdown-entity-aware — nothing in this PRD sets `parse_mode` yet, so
  entity-safe splitting has no caller; it arrives with a future
  Markdown-formatted output layer.
- `telegram/backoff.ts` — `nextDelay(attempt, retryAfterHeader?): number`,
  pure and clock-independent (callers pass the attempt count directly).
  Exponential growth from a fixed base, capped, with uniform jitter to avoid
  synchronized retries; `retryAfterHeader` always overrides the computed
  value when present.
- `telegram/poller.ts` — the long-poll loop (`timeout=30s`, `limit=100`,
  `allowed_updates=["message","edited_message"]`) plus
  `normalizeTelegramUpdate`, which converts a raw update into an
  `InboundMessage` or returns `null` when it can't (see guards below). The
  offset is loaded once at start via a `TelegramOffsetRepo` port (injected —
  `boot.ts` wires it to `@hermes/store`'s `getOffset`/`setOffset`, keeping
  this package decoupled from Postgres) and persisted after each update is
  fully handled. `TelegramPollerOptions.retryDelayMs` overrides the fixed
  delay used after a transient failure (tests inject a short value instead
  of waiting out the real one). `createTelegramPoller` returns a
  `TelegramPoller` — a `Channel` plus `stop(): Promise<void>`, which flips a
  `stopping` flag read by the loop's condition (so no new `getUpdates` call
  starts) and resolves once the loop has actually exited, in-flight handler
  included. See `apps/hermes/src/boot.ts`'s shutdown sequence for how this is
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

The poller persists `update_id + 1` **after** each individual update is
fully handled — never before, and never batched across a whole `getUpdates`
response. This ordering is load-bearing: Telegram permanently deletes an
update once its `update_id` has been acked via `offset` on a later
`getUpdates` call, so persisting earlier risks losing that update forever if
the process crashes mid-handling. Persisting later (or per-batch instead of
per-update) means an *already-handled* update can also be replayed, which is
harmless here but would not be for a handler with an external side effect.

This creates an explicit contract: **a crash between "handler completed" and
"offset persisted" replays exactly the one in-flight update on restart.**
`poller-crash-replay.test.ts` simulates this concretely — persistence fails
once, a fresh poller instance is built against the same (unchanged)
persisted offset, and the same update is shown to be re-delivered and
re-handled.

The echo handler is safe under this replay by inspection: send-and-reply has
no side effect beyond a second, user-visible duplicate message, so there is
no dedupe key here. **Any future handler with an external side effect**
(e.g. a later `log_trade`-style handler) **must add its own idempotency key**
per the project's at-least-once-delivery invariant — this phase solves
replay-safety only for echo, not generally.

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
