# Read-tool auditing stays on telemetry only — invariant 3 is partially open

**Decision:** Writes get a durable, synchronous audit (`sheet_write_log`, see
[sheets-write-dedupe-as-audit](sheets-write-dedupe-as-audit.md)). Reads —
`sheets_inspect`, `sheets_read`, `gmail_list_unread`, `gmail_search`,
`gmail_read_thread`, and every other read-only tool — are covered **only**
by the `tool.call` telemetry event, which is buffered and at-most-once.
ROADMAP invariant 3 ("every tool call is audited") is therefore satisfied for
mutations and **partially open** for reads. Recorded here as open, not closed.
Gmail's three read tools (`09-gmail-read-then-send` Phases 1-2) join this
deferred set on arrival, for the identical reasoning below — no new argument
was needed to extend it to a second capability package.

**Why deferred, not done:**

- **The guarantee costs the thing it protects.** A synchronous durable row per
  read tool call puts a Postgres write inside the request path of every read,
  for a class of call that mutates nothing and is already the cheap path.
- **The risk it would cover is different in kind.** The write audit exists to
  answer "did we change the user's data, and can we prove it" — a question with
  a wrong answer that is expensive. For reads the question is "what did the
  agent look at," which matters for forensics, not for correctness or
  recovery.
- **A dropped read event degrades a dashboard; a dropped write record could
  double-apply a mutation.** Those deserve different machinery, and pretending
  one mechanism covers both would be the actual mistake.

**What would close it:** a durable `tool_call_log` (or making the telemetry
recorder's write path synchronously durable for a declared subset of events),
plus a decision about retention — neither table has a retention policy today.

**Refinement (`09-gmail-read-then-send`): the standing constraint narrows
from "a new mutating tool" to "a new irreversible-or-ambiguity-prone
mutating tool."** `gmail_archive`/`gmail_label` (Phase 3) are genuine
mutations — they call `users.messages.modify` — yet deliberately ship with
**no** `sheet_write_log`-style durable claim/audit table, and this is not an
oversight left for later: `modifyMessage` is idempotent by Gmail's own label
semantics (re-archiving an already-archived thread, or re-adding an
already-present label, is a harmless no-op), so there is no double-apply
risk to hedge against, and Gmail's own mailbox state is itself the durable,
user-inspectable record of what happened. `gmail_send_draft` (Phase 5), by
contrast, is irreversible and its failures can be genuinely ambiguous
(a timeout or 5xx after the send request left, with no way to know from the
response alone whether it landed) — exactly the risk `sheet_write_log` was
built for — so it gets `gmail_send_log`, `sheet_write_log`'s structural twin.
See [gmail-send-intent-log](gmail-send-intent-log.md) for the full
narrowed rule ("irreversible or ambiguity-prone ⇒ durable claim + audit,
otherwise telemetry") and why archive/label land on the telemetry side of
it. This precedent is what settles the refined wording below: a mutation
being non-idempotent-or-irreversible is what triggers the durable-audit
requirement, not mutation alone.

**Constraints while it stays open:**

- Do not describe invariant 3 as satisfied. It is satisfied for
  `sheets_write` and `gmail_send_draft`.
- A new **irreversible or ambiguity-prone** mutating tool must add durable
  auditing on the `sheet_write_log` model (see
  [gmail-send-intent-log](gmail-send-intent-log.md) for the Gmail-specific
  three-state variant of that model). An idempotent, reversible mutating
  tool — the `gmail_archive`/`gmail_label` precedent — does not need one; a
  new read-only tool inherits this gap knowingly either way.
