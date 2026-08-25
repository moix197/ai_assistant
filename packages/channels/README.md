# @hermes/channels

Chat channel adapters. Phase 2 ships one: Telegram, long-polled, echo-only.

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

Business logic — allowlist enforcement, the private-chat-only guard, echoing
— lives in `apps/hermes/src/handlers/echo.ts`, not in this package. This
package's job stops at "reliably move messages in and out of Telegram."

## Telegram adapter

- `telegram/client.ts` — a raw-`fetch` wrapper around `getUpdates` and
  `sendMessage`. No telegraf/grammy: two endpoints don't justify a
  mega-package.
- `telegram/poller.ts` — the long-poll loop (`timeout=30s`, `limit=100`,
  `allowed_updates=["message","edited_message"]`) plus
  `normalizeTelegramUpdate`, which converts a raw update into an
  `InboundMessage` or returns `null` when it can't (see guards below).
  Offset tracking is in-memory only in this phase — persistence, the
  single-instance advisory lock, and structured backoff on failure all land
  in Phase 3/4. A transient `getUpdates` failure is logged and retried after
  a fixed short delay.
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
  support). `apps/hermes/src/handlers/echo.ts` rejects any message whose
  `chatType !== "private"`, logged at warn, **even from an allowlisted
  sender** — replying into a group broadcasts the reply to everyone in it,
  which is never the intent for a personal assistant bot.

### Deliberately deferred to Phase 4

- **Chunking**: nothing in this phase formats or generates output longer
  than what a user types in (echo only), so there's no caller for a message
  splitter yet. It arrives with `/ping`'s longer text output.
- **Backoff**: this phase's failure handling is a single fixed retry delay.
  Structured exponential backoff with `retry_after` handling only pays for
  itself once the poller needs to survive sustained rate-limiting or
  extended outages, which isn't exercised until later phases add more
  frequent outbound traffic.

Building either now would be machinery with no caller — see the project's
"no speculative abstractions" principle.
