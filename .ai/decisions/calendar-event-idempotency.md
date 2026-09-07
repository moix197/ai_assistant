# `create_event` idempotency: a client-supplied event `id`, not `iCalUID`

**Decision:** `create_event`'s idempotency key (settled decision 6:
"a stable id derived deterministically from the turn/approval identity,
enforced by the Calendar API itself on insert") is implemented as a
client-supplied Calendar event `id` (lowercase base32hex, 5-1024 chars),
derived by `deterministic-event-id.ts`'s `deriveEventId(turnId,
canonicalArgs)`, which delegates canonicalization and hashing to
`@hermes/core`'s new `sha256HexOfCanonicalJson` export — no separate
claim-log table like `SheetWriteLogPort`.

**The correction, flagged during planning, not re-litigated:** decision 6
was originally framed around Google Calendar's `iCalUID` field. That framing
was wrong — `events.insert` does not enforce uniqueness on `iCalUID` (that
dedup behavior belongs to the separate `events.import` endpoint, which has
different, sync-oriented semantics). The mechanism Google actually documents
for idempotent-retry inserts is a client-supplied event `id`: inserting
twice with the same `id` returns `409 Conflict` on the second call, which
`create_event`'s handler treats as "already created" and returns the
existing event via a `GET` instead of erroring. This satisfies decision 6's
actual intent — a deterministic key derived from the turn/approval identity,
uniqueness enforced server-side, no separate audit table — via `id`, not
`iCalUID`.

**What this id actually protects against.** `ctx.turnId` is generated once
per inbound message (once per `runTurn`), not once per approval-cycle, and
Telegram's approval gate already deletes a pending approval synchronously on
first resolution (`telegram-approval-gate.ts`) — a second tap on an
already-resolved approval gets an "expired" reply and never re-invokes
`handler`. So this id's real value is **not** double-tap protection on the
approval button (that path is already closed upstream, unrelated to this
mechanism). It protects against two things that are still possible:

1. The model emitting two identical `create_event` tool calls within the
   same turn — same hash, same id, the second insert 409s and is treated as
   already-created.
2. `calendar-client.ts` safely **retrying** an ambiguous insert failure
   (network drop, 5xx, 429) using the same freely-retried `withHttpRetry`
   policy the read tools use — unlike `sheets-client.ts`, which deliberately
   does *not* retry its own ambiguous write failures
   (`SheetsAmbiguousWriteError`) because Sheets has no idempotency key.
   Calendar's id-based `insert` can safely use the same retry policy as a
   read precisely because retries are idempotent by construction: a resend
   with the identical `id` either creates the event once or 409s against the
   copy the first attempt already created — never a duplicate.

**No cross-tenant collision risk.** `id` uniqueness is scoped per-calendar,
and every insert is authenticated as the calling user's own account — one
user's derived id can never collide with, or be confused for, another
user's event.

**Reuse, not a new encoder.** `deriveEventId` reuses
`google-sheets`'s canonicalization algorithm (`sortKeysDeep` + deterministic
JSON stringify + SHA-256 hex, originally in
`packages/google-sheets/src/canonical-args.ts`) via a new, additive
`@hermes/core` export (`sha256HexOfCanonicalJson`) rather than writing a
second implementation of the same algorithm. `google-sheets` itself is left
untouched — migrating its own `canonical-args.ts` to call the shared helper
is a follow-up cleanup, not in this plan's scope. A SHA-256 hex digest
(`0`-`9`, `a`-`f`) is already a valid base32hex string (`0`-`9`, `a`-`v`)
and well within Calendar's `id` field's 5-1024 character bound, so no
further encoding step is needed.
