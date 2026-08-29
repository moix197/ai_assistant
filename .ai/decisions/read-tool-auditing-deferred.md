# Read-tool auditing stays on telemetry only — invariant 3 is partially open

**Decision:** Writes get a durable, synchronous audit (`sheet_write_log`, see
[sheets-write-dedupe-as-audit](sheets-write-dedupe-as-audit.md)). Reads —
`sheets_inspect`, `sheets_read`, and every other read-only tool — are covered
**only** by the `tool.call` telemetry event, which is buffered and at-most-once.
ROADMAP invariant 3 ("every tool call is audited") is therefore satisfied for
mutations and **partially open** for reads. Recorded here as open, not closed.

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

**Constraints while it stays open:**

- Do not describe invariant 3 as satisfied. It is satisfied for `sheets_write`.
- A new **mutating** tool must add durable auditing on the `sheet_write_log`
  model. A new read-only tool inherits this gap knowingly.
