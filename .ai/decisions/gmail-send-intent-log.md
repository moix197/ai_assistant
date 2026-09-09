# `gmail_send_log`: a three-state intent/claim/complete lifecycle, and the narrowed audit rule it establishes

**Decision:** `gmail_send_draft` is backed by `@hermes/store`'s
`gmail_send_log` (`010_gmail_send_log.sql`), modeled on `sheet_write_log` but
widened with one extra state ahead of the claim: `awaiting_approval` →
`pending` → `complete`. Unlike `sheets_write`, whose `prepare` claims
nothing before a human sees the approval prompt, `gmail_send_draft`'s
`prepare` writes the `awaiting_approval` row — via `recordIntent` — *before*
the prompt is ever shown. `handler` (run only after approval) then `claim`s
the same dedupe key, which is the actual authorization-adjacent moment: it
transitions the row out of `awaiting_approval` (or inserts fresh) and is the
only thing that lets `sendDraft` be called.

**Why an intent row is written at `prepare` time, when `sheet_write_log`
writes nothing before approval:**

- **A send, unlike a sheet write, needs something durable to *report*
  against if the process dies mid-approval.** `sheets_write`'s prompt, if
  the process restarts before a tap, just goes stale — a re-issued request
  costs nothing extra to retry blind. A restart between "draft composed" and
  "human taps Approve" for a send is different: without a durable record,
  a stale tap after a restart can only ever answer "esta aprobación ya
  expiró" — true but useless, because it doesn't tell the human whether the
  mail actually went out. `apps/hermes/src/agent/telegram-approval-gate.ts`'s
  optional `describeExpiredApproval`, bound to `findLatestGmailSendIntent`,
  reads this exact row to answer definitively instead: a row still
  `awaiting_approval` in the lookback window proves `claim()` — the
  handler's only call site — never ran, so "no se envió nada, el borrador
  sigue guardado" is provably true, not a guess.
- **This is the one deliberate divergence from `sheets_write`'s `prepare`,
  which claims nothing.** Sheets has no equivalent state because a sheet
  write's failure mode (a stale prompt) has no report-worthy ambiguity to
  resolve; Gmail's does, specifically because sending is irreversible and a
  human may reasonably ask "did it go?" after a crash.

**The three claim outcomes and the definitive-vs-ambiguous release rule** —
identical shape to `sheet_write_log`'s claim, mirrored intentionally:

| Result | Meaning | Handler does |
| --- | --- | --- |
| `"claimed"` | row transitioned out of `awaiting_approval` (or inserted fresh) | proceeds to call `sendDraft` |
| `{ alreadyComplete, outcome }` | a prior call already finished | returns the **stored outcome**, zero further Gmail calls |
| `{ alreadyPending: true }` | a row exists mid-flight | returns the `ambiguous_send` hedge, writes nothing |

On a **definitive** failure (a non-429 4xx, or an exhausted 429 — provably
never reached Gmail per `classifySend`), the still-`pending` claim is
released so a legitimate same-turn retry isn't permanently blocked hedging
over a send that never landed. On an **ambiguous** failure (a
`GmailAmbiguousSendError` — a post-send timeout, a 5xx after the request
left, or an unrecognized network error that can't be proven pre-send), the
row is resolved via `complete(dedupeKey, outcome)` storing the
`ambiguous_send` result — a deliberate implementation divergence from the
plan's original prose (which called for leaving the row literally
`pending`), noted and accepted during Phase 5 review as functionally
equivalent: `turnId` is part of the dedupe key, so either way a same-turn
duplicate claim short-circuits to the same hedge without a second Gmail
call, and a genuinely later, different-`turnId` request is a fresh key
regardless of which terminal state the earlier row is left in.

**The intent-is-never-a-grant invariant:** an `awaiting_approval` row is
never itself a short-circuit for anything. `claim` only ever transitions a
row *out of* that state (or inserts fresh) — nothing anywhere reads a row's
mere presence, status, or content as authorization to call
`users.drafts.send`. `describeExpiredGmailSend` (`apps/hermes/src/boot.ts`)
only ever *reads* the log to describe what did or didn't happen; it never
resolves a pending approval, never touches the approval gate's own `pending`
map, and never calls the tool, the client, or `claim`. This must be stated
wherever `gmail_send_log` or its lifecycle is described — not only here —
because the whole design collapses into a genuine approval bypass if a
future edit ever treats a stored intent row as consent.

**The post-restart reporting seam:** `findLatestGmailSendIntent` returns the
newest row for a `(channel, channelUserId)` created within a bounded
lookback window (24h) — generous enough to answer a legitimately stale tap,
bounded so an unrelated years-old row can never surface. It only ever
speaks when the newest matching row is still `awaiting_approval`; any other
status falls back to the gate's generic expiry text, which stays true (if
uninformative) either way.

**The narrowed audit rule — "irreversible or ambiguity-prone ⇒ durable
claim + audit, otherwise telemetry" — and why archive/label land on the
telemetry side:** `gmail_archive`/`gmail_label` call `users.messages.modify`,
which is genuinely idempotent — re-archiving an already-archived thread, or
re-adding an already-present label, is a harmless no-op. There is nothing to
double-apply and therefore nothing to hedge against: a crashed process or an
ambiguous HTTP response is always safe to retry outright, and Gmail's own
mailbox state (the thread is or isn't in the inbox, the label is or isn't
applied) is itself the durable, user-inspectable record of what happened.
Logging every archive/label call the same synchronous claim-and-audit way
`gmail_send_log` does would add a Postgres write to every mutation of this
kind for a question ("did this land") the mailbox itself already answers,
and a question ("did we duplicate a side effect") that structurally cannot
arise for an idempotent call. `gmail_send_draft` is the opposite on both
counts: sending is irreversible (there is no undo once the message leaves),
and a definitively-unresolvable API response genuinely creates ambiguity a
retry could turn into a duplicate email reaching a real human — exactly the
class of risk `sheet_write_log` was built for, and exactly why
`gmail_send_log` exists as its structural twin.

**Rejected:**

- *Auto-resume from a button tap after a restart* — the pending approval
  itself is in-memory only (see `approval-gate-design.md`'s stopgap); nothing
  in this design attempts to resurrect it. A stale tap only ever gets a
  descriptive answer, never a resumed send.
- *Persisted approvals* (durably storing the pending approval prompt itself,
  not just the intent) — out of scope for this plan; the intent row exists
  to *report*, not to make an approval survive a restart.
- *An always-allow affordance* (e.g. a button or flag that lets a future send
  skip the approval gate) — no such mechanism exists anywhere in this
  design, and none should be added: the intent row's existence must never be
  read as reducing what a human has to confirm.
- *Treating `alreadyPending` as claimable (fail open)* — the same doubled-send
  risk `sheet_write_log`'s design already rejected for doubled-append;
  resending on ambiguity is exactly the failure mode this table exists to
  prevent.
- *Logging archive/label the same synchronous claim-and-audit way as send* —
  see the narrowed audit rule above: no double-apply risk to guard against,
  so the row would record nothing a human or the mailbox itself doesn't
  already show.
- *Async/best-effort logging for the reversible tools* — would add a write
  path and an unanswered retention question for a class of call this repo
  has already decided, in
  [read-tool-auditing-deferred](read-tool-auditing-deferred.md), is a
  forensics nice-to-have rather than a correctness need.

**Constraints it creates:**

- No code path may treat a `gmail_send_log` row's presence, status, or
  content as authorization — only `claim`'s own transition (approved calls
  only) may precede a `sendDraft` call. State this explicitly in any new
  doc or index row that describes the table, not only here.
- A new irreversible-or-ambiguity-prone Gmail mutation follows this table's
  three-state shape (intent at `prepare`, claim at approved-handler-time,
  complete/release after); a new idempotent, reversible mutation does not
  need one — see [read-tool-auditing-deferred](read-tool-auditing-deferred.md)
  for the refined standing rule this precedent established.
- `gmail_send_log` has no retention policy and grows unbounded, the same as
  `sheet_write_log` and `telemetry_events`.
