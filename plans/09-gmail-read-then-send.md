# Plan: Gmail — Read First, Then Send (Roadmap Phase 6)

**Created:** 2026-09-06
**Branch:** `feat/09-gmail-read-then-send`
**Status:** not started

## Context

ROADMAP Phase 6 is the highest-risk phase in the project: *read is cheap,
send is irreversible*. Every prior Google phase mutated something the user
could inspect and undo — a spreadsheet cell, a registry row. A sent email
cannot be recalled, cannot be edited, and reaches a third party the user
never approved if the model gets a recipient wrong.

This plan ships a generic `@hermes/google-gmail` package — a thin `fetch`
client over the Gmail v1 REST API plus our own MIME/HTML→text/quoted-reply
utilities — and **seven** tools, in an order where the read surface ships,
is used, and is proven before any code path capable of sending exists:

- **Read (ungated):** `gmail_search`, `gmail_list_unread`, `gmail_read_thread`
- **Write (all approval-gated):** `gmail_draft_reply`, `gmail_send_draft`,
  `gmail_archive`, `gmail_label`

The organizing principle is structural, not procedural. Gmail gets **two
scope tiers**: `/connect google gmail` grants identity + `gmail.readonly`;
`/connect google gmail-send` grants identity + `gmail.readonly` +
`gmail.modify` + `gmail.send`. While Phases 1-2 are being built and verified,
no token in the system is *capable* of sending — not "we chose not to call
send", but "the grant does not authorize it". From Phase 3 the write grant
exists, but no tool in the registry can send until Phase 5 lands
`gmail_send_draft` together with its durable send log.

**The draft is the safety mechanism, not a UI nicety.** `gmail_draft_reply`
calls Gmail's real `drafts.create`/`drafts.update` and returns a `draftId`
plus the rendered body. Its approval prompt *is* "you read it in Telegram" —
the user sees the actual text before the draft is even created. "Edit by
replying" is simply the user's next chat message: a normal fresh turn where
the model calls `gmail_draft_reply` again against the same `draftId`. **No
inbound reply-correlation mechanism is built.** `gmail_send_draft` takes a
`draftId` and is the only irreversible step. Because the draft survives in
Gmail through every failure mode — a denied approval, a crashed process, an
ambiguous API response — every failure is recoverable by asking again.

**Explicitly out of scope, owned by later work or deliberately dropped:**

- **`summarize_inbox` (the ROADMAP's eighth tool) is dropped.** With tools
  returning bounded *facts* rather than prose, `summarize_inbox` would be
  `gmail_list_unread` with different defaults — a second way to do one thing,
  which CLAUDE.md's "reuse before reinvent" forbids. "¿Hay algo urgente
  hoy?" is satisfied by the model calling `gmail_list_unread`, picking one to
  three candidates off the returned senders/subjects/dates/flags, calling
  `gmail_read_thread` on them, and triaging — all inside one turn, well
  within `MAX_ITERATIONS = 8` (`.ai/decisions/agent-loop-design.md`). Phase 7
  verifies exactly that path.
- **Any LLM call inside a tool.** Tools return structured, bounded facts;
  the model already running the turn does the summarizing. A tool-internal
  model call would break one-paid-turn-one-outcome
  (`plans/07-one-paid-turn-one-outcome.md`), sit outside the monthly budget
  ceiling's accounting, and make every tool non-deterministic and
  hard to unit-test.
- **A mailbox registry.** Unlike Sheets' `SheetRegistryPort`/`resolveSheet`
  reach-gate, the whole mailbox is in reach by construction. Reach is bounded
  by the readonly/send scope split and by approval-gating every mutation.
  No recipient allowlist, no label allowlist, no `GmailToolDeps.registry`.
- **Auto-resuming a send after a restart.** A tap on a dead approval never
  executes a send (see Dependencies & Risks).
- **Attachments, threading beyond `In-Reply-To`/`References`, rich HTML
  composition, forwarding, delete/trash, filters, push notifications.**
  Reads parse whatever MIME arrives; composition is `text/plain` only.
- **Google verification / CASA review.** Gmail scopes are **restricted** —
  a real-world prerequisite named in HIL Prerequisites and Dependencies &
  Risks, not solved here.
- **Read-tool auditing.** Still deferred, unchanged
  (`.ai/decisions/read-tool-auditing-deferred.md`).

**Packages created here**, per D3 ("create at its phase, never
merge-then-split"): `packages/google-gmail` only.

**Packages modified here:** `packages/google-auth` (`scopes.ts` gains
`GMAIL_READ_SCOPES`/`GMAIL_WRITE_SCOPES`, one `resolveConnectScopes` branch
per tier, seven `TOOL_REQUIRED_SCOPES` rows), `packages/store` (a
`gmail_send_log` migration + repo, Phase 5), `apps/hermes` (`build-agent.ts`
gains seven tools, `boot.ts` gains `buildGmailDeps` + the send-log port,
`with-required-scopes.ts`'s `describeConnectCommand` is generalized,
`build-access-token-port.ts` is de-Sheets-ified,
`telegram-approval-gate.ts` gains an optional expired-tap describer).
`packages/agent` is **not** modified: `ToolSpec`, `ToolPreparation`,
`ApprovalSummary` and the loop already carry everything these seven tools
need.

## Risk: high

Three things earn "high", and only one of them is code. First, **`gmail_send_draft`
is the first genuinely irreversible action in this codebase** — every prior
gated mutation wrote to a store the user could open and fix. A recipient
bug, a double-send, or an approval prompt that describes one draft and sends
another is not a defect to be patched next week; the mail is gone. Second,
**mail bodies are the largest and least controlled text this system has ever
put into model context** — an unbounded HTML newsletter thread would silently
dominate the window with no error signal, exactly the failure mode
`.ai/decisions/bounded-tool-results.md` exists to prevent, and this plan has
to prevent it against adversarially messy input (nested `multipart/*`,
base64url, quoted-printable, hundred-message threads, quoted history that
re-includes every earlier message). Third, **Gmail scopes are restricted by
Google**, not merely sensitive like `spreadsheets`: leaving Testing
publishing status requires verification *and* a third-party CASA security
assessment. That is a real-world calendar risk on the whole phase, not a
code risk, and it is named in HIL Prerequisites rather than solved.

## Dependencies & Risks

- **Two scope tiers, and why the send tier explicitly re-requests
  `gmail.readonly` (settled decision 1).**
  `GMAIL_READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]`;
  `GMAIL_WRITE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send"]`. `resolveConnectScopes`
  maps `"gmail"` to `[...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES]` and
  `"gmail-send"` to `[...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES,
  ...GMAIL_WRITE_SCOPES]`. `gmail.modify` functionally implies read, but
  `hasRequiredScopes` (`packages/google-auth/src/scopes.ts:18-20`) is
  **literal string containment** — it has no implication table and this plan
  does not add one, because a scope-implication graph is exactly the kind of
  speculative mechanism CLAUDE.md forbids and exactly the kind of thing that
  fails open when it is wrong. Keeping `TOOL_REQUIRED_SCOPES` flat and
  literal (each of the seven tools lists the exact scope strings it needs)
  costs one redundant scope in the send tier's consent request and buys a
  gate whose rule is one line long. **Named risk, verify at execution time:**
  if Google normalizes a combined `gmail.readonly` + `gmail.modify` request
  and returns only `gmail.modify` in the token response's `scope` field, the
  three read tools would fail their scope gate for a send-tier-only user.
  The contingency needs no new mechanism: the read tools' `fix` string
  already sends the user to `/connect google gmail`, and
  `include_granted_scopes: "true"` makes that grant cumulative on top of the
  send tier. Phase 3's verification step checks `/status` output for the
  literal `gmail.readonly` string specifically to catch this.
- **The read-before-send guarantee is structural for Phases 1-2 and
  registry-shaped from Phase 3 — state both halves honestly.** During Phases
  1 and 2 the only Gmail grant the user has is `gmail.readonly`: no token in
  the system can send, archive, label, or draft, regardless of any bug in
  tool wiring. Phase 3 requires the write tier (archive/label need
  `gmail.modify`, which shares a tier with `gmail.send` by settled decision
  1), so from Phase 3 onward the *grant* includes send capability while the
  *tool registry* contains nothing that can send — `gmail_send_draft` does
  not exist until Phase 5. That is a weaker guarantee than Phases 1-2's and
  the plan says so rather than pretending the tiering does more than it does.
- **There is no "always allow" mechanism anywhere in this codebase, and this
  plan does not introduce one — this is the invariant the plan protects.**
  Approvals are per-batch and in-memory only: `pending` is a plain `Map` in
  `apps/hermes/src/agent/telegram-approval-gate.ts:85`, never persisted,
  dropped entirely by a restart
  (`.ai/decisions/approval-gate-design.md`). The ROADMAP's rule that
  `send_draft` "always requires explicit confirmation, with no always-allow
  escape hatch" is therefore satisfied **by construction**, not by a check
  this plan adds. The plan's only job is to not build one. **The subtlety
  that must not be lost:** Phase 5 persists a send *intent* and its approval
  state in `gmail_send_log` for reporting. That row is **not a grant**. It is
  never read as consent, never replayed to authorize a send, and no code path
  turns a stored row into an executed API call — the only thing that ever
  reads it is a message renderer telling a human what did or did not happen.
  A row saying `awaiting_approval` and a row saying nothing at all produce
  the same outcome: no mail is sent.
- **A tap on a dead approval reports a definite state; it never resumes
  (settled decision 3).** Today a post-restart tap hits the
  `pending.get()` miss branch
  (`telegram-approval-gate.ts:153-156`) and answers
  `"esta aprobación ya expiró, pídelo de nuevo"` — true but useless when the
  question was "did my email go out?". Phase 5 gives
  `createTelegramApprovalGate` an **optional** injected
  `describeExpiredApproval(channel, channelUserId): Promise<string | undefined>`;
  `boot.ts` binds it to a `gmail_send_log` lookup of the newest recent row
  for that user. A hit renders a definite Spanish sentence ("no se envió
  nada, el borrador sigue guardado — pedime «envialo» de nuevo"); a miss or
  a thrown lookup falls back to today's exact string, byte-identical.
  **Rejected: auto-resume** — having the callback handler send the mail
  itself would put an irreversible Google API call outside the agent loop,
  outside `ToolSpec.timeoutMs`, outside the tool telemetry, and outside the
  turn's `AbortSignal`, and would mean a tap on a five-hour-old button sends
  mail composed against a mailbox state that no longer exists. Recorded with
  its reasoning in `.ai/decisions/gmail-send-intent-log.md`.
- **A send approval that simply times out (no restart) resolves exactly like
  a Rechazar tap, by the existing unmodified mechanism.**
  `telegram-approval-gate.ts`'s `requestApproval` races the 5-minute
  `timeoutMs` against a tap; when the timer wins it calls
  `entry.resolve("denied")` and edits the message to "Rechazado (o expiró)."
  — this phase adds no send-specific timeout handling because none is
  needed: the handler is never reached, so the `gmail_send_log` row stays in
  `awaiting_approval` (never claimed), the draft is untouched, and the
  user-visible message already says so. The distinction from the *dead*
  approval case above is only ever "was the process still running when the
  clock ran out" — both leave the exact same state behind.
- **Whole-batch approval is a real hazard for a batch that mixes
  `gmail_send_draft` with another gated call, and this plan does not change
  the gate to fix it — it relies on what the gate already renders.**
  `ApprovalGate.requestApproval` (`packages/agent/src/
  approval-gate-port.ts:65-71`) resolves one batch — every gated call from
  the same model response — with a single `"approved" | "denied"`; one
  **Aprobar** tap approves everything in it. `formatBatchPrompt`
  (`approval-prompt-renderer.ts:93-95`) already renders **every** call in
  the batch as its own block, so a mixed batch is never hidden behind one
  line — a send sitting next to an archive shows both actions, both
  `target`s, and both `effects` (send's says "Esto no se envía... no se
  puede deshacer") before the single tap. That mitigates the hazard (nothing
  is silently bundled) without eliminating it (one tap still greenlights
  both). This plan does not force `gmail_send_draft` into its own batch —
  doing so would mean `packages/agent` inspecting tool identity to split a
  batch, which is exactly the kind of mechanism this plan is elsewhere
  careful not to add, and in practice a model replying to one Telegram
  message rarely bundles "send this" with an unrelated mutation in the same
  turn. **Named as an accepted residual risk, not solved here**: if this
  becomes a real problem in practice, the fix belongs in `packages/agent`
  (e.g. a tool-level flag forcing solo-batch approval) and is out of this
  plan's scope, which touches `packages/agent` not at all (see Context).
- **`gmail_send_log` writes an intent row at `prepare` time — a deliberate
  divergence from `sheet_write_log`, which writes nothing before approval.**
  `sheets_write` claims only inside the handler, after consent, on the
  principle that "claiming commits to actually attempting the write"
  (`plans/06-legible-approvals-bounded-reads.md`'s Dependencies & Risks).
  Gmail needs one more thing Sheets did not: after a crash mid-approval,
  something durable must exist to *report* against, or the honest answer to
  "did it send?" stays "I don't know". So the row's lifecycle gains a state
  ahead of the claim: `awaiting_approval` (written by `prepare`, carries no
  consent) → `pending` (the claim, written by the handler before the API
  call) → `complete` (outcome recorded after). The claim keeps
  `sheet_write_log`'s exact **three** outcomes — `"claimed"` /
  `{alreadyComplete, outcome}` / `{alreadyPending: true}` — and its
  definitive-vs-ambiguous `release` discipline: `release` deletes only a
  still-`pending` row and only when the failure is *provably definitive*
  (a non-429 4xx, or an exhausted 429 — Gmail rejected the request before
  applying it). A post-send timeout, a 5xx after the request left, a
  malformed body after a 2xx: the pending row stays and the tool returns the
  `ambiguous_send` hedge instead of retrying. **An ambiguous send is exactly
  the case that must hedge**, because the recovery for a false "it failed"
  is a duplicate email to a real human.
  **Why a stale row can never authorize a later turn's send:** the dedupe
  key hashes `[channel, channelUserId, turnId, tool, canonicalArgs]`, so a
  send triggered by turn N computes a key that turn N+1's "envialo" (a fresh
  turn, a fresh `turnId`) can never reproduce. A later turn's call is
  therefore always a **key miss**, not a lookup against N's row — it goes
  through `prepare` and a brand-new approval prompt exactly like the first
  send did. There is no code path where an old row's presence, absence, or
  status changes what a new turn is asked to approve; the only thing a row
  is ever read for is the post-restart *report* to a human, described below.
- **`drafts.send` deletes the draft it sends — the recoverability property
  from decision 2 ends exactly at a successful send, on purpose.** Gmail's
  API removes the draft resource once it sends and returns the resulting
  sent *message* (a new message id, on the existing thread) instead. Two
  consequences the tool and its log must get right: (1) `complete(dedupeKey,
  outcome)` stores the **sent message id**, not the now-gone `draftId` — an
  `alreadyComplete` replay hands back that message id, never attempts a
  second `getDraft`/`sendDraft` against an id that no longer resolves; (2)
  this is the one place the plan's "every failure is recoverable because the
  draft survives" claim does not apply, and it is not supposed to — success
  is not a failure to recover from, it is the terminal state the whole gate
  exists to reach exactly once. Every *failure* path (denied, timed out,
  restarted mid-prompt, definitively rejected by Gmail) still leaves the
  draft intact, because none of those paths ever call `sendDraft`.
- **Because `prepare` re-fetches the draft fresh on every `gmail_send_draft`
  call, an edit made directly in the Gmail UI between `draft_reply` and
  `send_draft` is exactly what gets shown and sent — never a stale cached
  body.** `prepare`'s `getDraft` call reads the draft's *current* server
  state each time the tool runs; there is no snapshot taken at
  `draft_reply` time that `send_draft` could go stale against. A draft
  deleted directly in Gmail (not through this bot) is caught by the same
  `getDraft` call and refuses pre-prompt as `draft_not_found` — the same
  refusal Phase 5's file-changes row already describes for a vanished
  `draftId`; that refusal already covers "someone deleted it out from under
  us," not only "the id was never valid."
- **Archive and label do not get a durable claim log, and that is a
  deliberate, recorded refinement of an existing constraint.**
  `.ai/decisions/read-tool-auditing-deferred.md` records "a new mutating tool
  must add durable auditing on the `sheet_write_log` model." The purpose of
  that constraint is that a spreadsheet cell carries no provenance — nothing
  in the sheet says who wrote it or whether the write was applied twice.
  Gmail is different in kind: `users.messages.modify` is **idempotent**
  (adding a label already present is a no-op; the second archive of an
  archived thread changes nothing), and Gmail is itself a durable,
  user-inspectable record — an archived thread is visible in All Mail, a
  labelled thread under its label. Archive/label are therefore audited by the
  existing at-most-once `tool.call` telemetry plus Gmail's own history, and
  the constraint is refined in Phase 6 to read "a new **irreversible or
  ambiguity-prone** mutating tool must add durable auditing." `gmail_send_draft`
  is both, and gets the full table.
- **Live 401/403 becomes a structured refusal, and this is the first
  API-side re-auth path in the codebase (settled decision 8).** Today only a
  refresh-time `invalid_grant` has a re-auth path
  (`apps/hermes/src/google/refresh-sweep.ts` — disconnect + Telegram alert);
  `.ai/index.md`'s Google-OAuth row states outright that API-side 401/403 has
  none. The Gmail client's `classify` treats 401/403 as non-retryable and
  **throws** them (per `withHttpRetry`'s contract — a non-retryable error is
  thrown from `classify`, never returned as a class), and each tool handler
  converts a caught `GmailApiError` with status 401/403 into
  `{ ok: false, reason: "insufficient_scope", scope, fix: "corré /connect google gmail-send" }`
  — **the same field shape `withRequiredScopes`'s pre-call gate already
  returns** (`with-required-scopes.ts:78-88`), so the model relays it
  verbatim and there is one refusal vocabulary, not two. **The model never
  mints a consent URL** — `/connect` is a command handler, not a tool; that
  invariant is unchanged. **Do not disconnect the account on a 403**, unlike
  refresh-time `invalid_grant`: a Gmail 403 can be per-message (a thread the
  user cannot access) or per-scope, and disconnecting would nuke a working
  Sheets connection over an unrelated mailbox permission. **The refusal
  shape does not vary by cause** — a scope-insufficient 403 for "you haven't
  granted send" and a Gmail-side 403 for "you can't access this specific
  thread" both come back as the identical `{ok:false,
  reason:"insufficient_scope", scope, fix}`, so the shape itself never tells
  the model (or, downstream, the user) which of the two happened. This is
  not a third-party-enumeration concern the way it would be for a
  multi-tenant API: every Gmail call in this plan operates inside the one
  connected account's own mailbox (settled decision 7 — no registry, no
  cross-account reach), so a 403's cause is at most information about the
  user's *own* mail, never another person's. A **404** (`thread_not_found`,
  `draft_not_found`) is deliberately a different, more specific refusal than
  `insufficient_scope` — that distinction is safe to expose for the same
  reason: it can only ever be about an id inside the user's own mailbox.
- **No mail body or recipient address is ever included in telemetry, and
  debug-level approval logging is the one pre-existing seam where a body
  *could* leak if enabled.** The `tool.call` telemetry event
  (`packages/agent/src/loop.ts:222-231`) carries only
  `{tool, durationMs, approved, approvalWaitMs?, error?}` — never `args` or a
  result — so this holds for all seven Gmail tools with no new work. The one
  place with different exposure: `telegram-approval-gate.ts`'s
  `logPreparedBatch` logs each call's **`plan`** (not `summary`) at debug
  level, and `gmail_draft_reply`/`gmail_send_draft`'s `plan` carries `raw`,
  the actual composed message. This is pre-existing, generic behavior this
  plan does not change (it already applies to `sheets_write`'s resolved
  values) and it is off by default in production — but it is worth stating
  plainly, not silently inheriting: enabling debug logging in production
  would, for the first time, put real mail body text into logs. This plan
  does not add a Gmail-specific carve-out for it, on minimal-change grounds
  (`packages/agent` and the gate's generic logging are explicitly out of
  scope — see Context), and instead names it here so operating this
  deployment with debug logging on is a known, not a surprised-later,
  tradeoff.
- **Bounded bodies are the whole point of the read phases, and the bound
  runs tool-side after the API response, never in `loop.ts`.** Two caps
  compose: a per-message character cap (~2,000 chars) applied **after**
  HTML→text conversion and quoted-reply stripping — so the cap is spent on
  new content, not on the same quoted history repeated down a thread — and a
  newest-first per-thread message cap (~10). Truncation fields
  (`truncated`, `returnedCount`/`returnedMessages`,
  `totalCount`/`totalMessages`, plus a Spanish model-facing `note`) are
  **additive via conditional spread**, so an untruncated result is
  byte-identical to the un-capped shape — the exact contract
  `.ai/decisions/bounded-tool-results.md` fixed for Sheets. The `note` must
  only promise a remedy the tool can actually honor (that doc's own rule):
  `gmail_read_thread`'s note may say "pedime los mensajes más viejos" only
  because the tool accepts a pagination/offset argument; if it does not, the
  note says what was dropped and nothing more.
- **The truncation helper stays Gmail-local, deliberately.**
  `truncateBySize`/`measureRow` live in
  `packages/google-sheets/src/truncate.ts` and are not exported from
  `@hermes/core`. Gmail is the **second** caller-package, and this repo's
  documented norm — set by
  `.ai/decisions/http-retry-helper-extraction.md`, which extracted
  `withHttpRetry` into `core` only once there was a third caller — is to wait
  for the third. Promoting now would also mean editing a shipped package's
  public surface (`@hermes/google-sheets`'s `index.ts`) and re-testing three
  Sheets tools for zero behavior change, for one consumer. So
  `packages/google-gmail/src/truncate.ts` gets its own `truncateBySize`-shaped
  bound with a mail-appropriate `measure` (`{ messages, chars }`, not
  `{ cells, chars }`) and the same always-keep-at-least-one rule, and the
  promotion trigger — a third caller-package needing a size bound — is
  recorded in `.ai/decisions/gmail-body-bounding.md` so the next phase finds
  it rather than re-deciding.
- **We build our own MIME, HTML→text, and quoted-reply stripping — no mail
  library (ROADMAP §6, CLAUDE.md's dependency bars).** What we need is
  narrow: base64url decode, a recursive walk of `payload.parts` preferring
  `text/plain` over `text/html`, quoted-printable decode, entity/tag
  stripping, and a handful of quote-boundary heuristics ("On … wrote:",
  "El … escribió:", leading `>`, `--` signature separators,
  `<blockquote>`/`gmail_quote`). A general MIME library clears neither bar —
  it is not load-bearing (we parse a JSON payload Google already
  structured for us, not a raw wire stream), and mail parsers are a
  historically CVE-dense category to hand untrusted input to. **No new
  dependency is expected.** If a phase discovers a genuine need, it gets a
  written `.ai/decisions/` justification against both bars before landing,
  the same posture `05-google-sheets` took.
- **Composition needs RFC 2047, and Spanish makes that immediate.**
  `drafts.create` takes a raw RFC 2822 message, base64url-encoded. A subject
  like `Re: Confirmación de la reunión` is non-ASCII, so the `Subject`
  header must be encoded-word-encoded (`=?UTF-8?B?…?=`) or Gmail will render
  mojibake — this is not a hypothetical edge case for this user population,
  it is the default case. The body is `Content-Type: text/plain;
  charset="UTF-8"` with `Content-Transfer-Encoding: base64`. Threading
  requires both the `threadId` field on the draft's message resource **and**
  `In-Reply-To`/`References` headers carrying the parent's `Message-ID`;
  omitting the headers produces a message that lands in the thread on Gmail's
  side but breaks threading in every other client.
- **`ScopedToolContext.googleAccount` already carries the connected
  account, including its email** (`with-required-scopes.ts:19` — the account
  is fetched once by the gate and threaded into ctx). Gmail tools read
  `ctx.googleAccount.email` for the `From` identity and for Phase 7's
  send-to-self verification, rather than calling `users.getProfile` or
  re-reading the account row.
- **Per-tool timeouts and the client's own request timeout are two
  independent, nested bounds** (`.ai/decisions/per-tool-timeout.md`). Gmail
  tools declare `timeoutMs: 30_000` (matching the Sheets tools); the client
  keeps its own `REQUEST_TIMEOUT_MS = 10_000` per HTTP attempt, retries
  included in the outer bound. `gmail_read_thread` fans out over several
  `messages.get` calls and is the one most likely to press the 30s budget —
  Phase 2 caps the fan-out by the per-thread message cap *before* issuing the
  gets, not after.
- **Every tool schema must be a top-level `z.object`**
  (`.ai/decisions/tool-arg-schema-top-level-object.md`) — a root
  `z.discriminatedUnion` emits `anyOf` with no `type` and DeepSeek 400s
  **every** request, since all tool schemas ship on every completion.
  `gmail_label`'s add/remove variance therefore uses the flat-object-plus-enum
  shape `sheets_write`'s `mode` established, never a root union. The existing
  guard (`apps/hermes/src/agent/__tests__/tool-schemas.test.ts`) sweeps the
  real `buildAgent` array and will cover all seven automatically.
- **The runtime resolves `main` → `dist`, so a new package is invisible until
  built.** `pnpm build` (or root `predev`, which runs `pnpm -r build`) is
  required after every `packages/google-gmail` edit before the dev bot sees
  it — this is the exact trap that shipped a stale `sheets_write` prompt in
  `06-legible-approvals-bounded-reads`. Named as a step in Phase 1 and in
  every manual verification.
- **No CI change, and no automated live-Gmail lane.** The single live send
  is a **manual HIL step in Phase 5/7**, not a `*.live.test.ts` suite — so
  `.ai/decisions/ci-lane-policy.md`'s `live-lane-excluded.test.ts` guard and
  the `test:live` scripts are untouched. The `gmail_send_log` repo's DB suite
  joins the existing `pnpm test:db` lane through
  `@hermes/store/testing`'s shared guard, never a privately-resolved
  `TEST_DATABASE_URL` (`.ai/decisions/test-database-isolation.md`).
- **`pnpm lint` is a named Final Verification gate**, same as
  `05-google-sheets`/`06-legible-approvals-bounded-reads`.

### Parallel-plan contention: Phase 5 (Calendar) is being planned concurrently

Phase 5 (Calendar) and Phase 6 (Gmail) are genuinely independent
(`.ai/decisions/defer-trading-journal.md` says so explicitly) — they share no
package, no table, and no tool. They collide **line-wise, never
semantically**, in a small, enumerable set of places, and every edit this
plan makes to them is deliberately **append-shaped** so either plan can land
first:

1. **`packages/google-auth/src/scopes.ts`** — Gmail adds a new scope-const
   block (`GMAIL_READ_SCOPES`/`GMAIL_WRITE_SCOPES`) after `SHEETS_SCOPES`;
   Calendar adds its own. Zero conflict. `resolveConnectScopes` gains two
   `if (normalized === …) return …;` lines at the same insertion point
   Calendar uses — a textual conflict, resolved by keeping both lines in any
   order. `TOOL_REQUIRED_SCOPES` gains seven rows appended immediately before
   the closing `]);` — same shape, same resolution.
2. **`apps/hermes/src/agent/build-agent.ts`** — the import block, the
   `withRequiredScopes(...)` const chain, and the `tools: [...]` array all
   take appends. Existing array **prefix order must not change** (ROADMAP
   invariant 6 — prompt-cache prefix stability): new tools go at the end,
   after `sheetsWriteTool`, in both plans. `buildAgent`'s parameter list
   gains `gmailDeps` (and, Phase 5, `gmailSendLogRepo`) — append at the end
   of the signature, before the defaulted `logger` parameter.
3. **`apps/hermes/src/agent/with-required-scopes.ts`'s
   `describeConnectCommand` (`:57`)** — today it hardcodes a two-tier
   Sheets/identity branch. Both plans need it generalized to a table-driven
   scope-set → connect-command mapping. **Write this as an idempotent step:**
   whoever lands first performs the generalization; the second plan finds it
   already done and only adds its own row(s). Phase 1's step is worded that
   way, and its test asserts only the Gmail rows plus the unchanged Sheets
   and identity ones.
4. **`apps/hermes/src/google/build-access-token-port.ts`** — a likely third
   touchpoint the contention brief did not name. It is currently *typed* to
   `@hermes/google-sheets`'s `AccessTokenPort`. See the resolution below;
   the edit is idempotent in exactly the same way as (3).
5. **Migration filename numbering** — `packages/store/src/migrations/` is at
   `009_sheet_write_log.sql`, so `010_` is the next free number. **Verified
   against the Calendar plan: it adds no migration at all** (it persists
   nothing new), so `010_` is uncontested and this is not a live contention
   point. Recorded here only so a future third plan does not rediscover it.
   Should two plans ever want the same number, the failure mode is *not* a
   boot-time crash: `sortMigrationFilenames` (`packages/store/src/migrate.ts`)
   filters `*.sql` and sorts on the **full filename**, and the applied id in
   `schema_migrations` *is* the filename — so two files sharing a numeric
   prefix get distinct ids and both apply, deterministically ordered by the
   rest of the name. The real hazard is silent inter-migration ordering, which
   no compiler and no unique constraint will catch. **Still pick the next free
   number at execution time** rather than hardcoding `010` from this document.

### Resolved here, not deferred: `buildAccessTokenPort`'s Sheets-typed signature

`apps/hermes/src/google/build-access-token-port.ts` returns
`AccessTokenPort` **imported from `@hermes/google-sheets`**. Gmail declares
its own structurally-identical port
(`getAccessToken(channel, channelUserId): Promise<string>`) per the
consumer-declares-its-port convention every capability package follows.

**Decision: keep exactly one builder and one refresh seam; stop typing it to
a feature package.** `build-access-token-port.ts` declares the return type
locally (`export interface GoogleAccessTokenPort { getAccessToken(channel: string, channelUserId: string): Promise<string> }`)
and drops the `@hermes/google-sheets` type import; structural typing then
satisfies both packages' independently-declared ports with no cast and no
change to either package. Its "cannot fetch a **Sheets** access token" error
string becomes "cannot fetch a Google access token".

Rejected: a parallel `buildGmailAccessTokenPort`. It would be a
character-for-character duplicate of a function whose entire doc comment
explains that `RefreshCoordinator.getValidAccessToken` is *the single seam
so a request-path tool call never needs a second refresh path* — duplicating
it recreates precisely the hazard `05-google-sheets`' review caught when two
`RefreshCoordinator` instances shipped. Also rejected: importing the Gmail
port type instead of the Sheets one (moves the arbitrary coupling, doesn't
remove it).

## HIL Prerequisites (manual, before Phase 1)

**Mode:** hil

Google's console UI and its per-method scope tables change over time — treat
every label, menu path, and per-endpoint scope below as **verify at execution
time**; the underlying requirements are fixed.

- [ ] Add `https://www.googleapis.com/auth/gmail.readonly` to the OAuth
      consent screen's scope list (the same Cloud project
      `04-google-auth`/`05-google-sheets` use, not a new one). This is
      enough for Phases 1-2.
- [ ] Add `https://www.googleapis.com/auth/gmail.modify` and
      `https://www.googleapis.com/auth/gmail.send` before Phase 3. Adding
      them later, not up front, keeps the read phases honestly unable to
      send.
- [ ] Enable the **Gmail API** for the project (Sheets being enabled does
      not enable Gmail).
- [ ] **Flag as a real-world risk, not solved here: Gmail scopes are
      RESTRICTED**, a stricter class than `spreadsheets` (merely
      *sensitive*). Publishing the app beyond **Testing** status with
      restricted scopes requires Google verification **and** a third-party
      CASA security assessment, with real cost and multi-week lead time.
      Staying in Testing keeps the 7-day refresh-token expiry
      `05-google-sheets` already named. That decision belongs to whoever
      operates this deployment; this plan assumes Testing status and weekly
      reconnects.
- [ ] Confirm the connected Google account is a mailbox with (a) at least a
      few unread messages, (b) at least one HTML-only newsletter, (c) at
      least one long reply chain with quoted history, and (d) at least one
      thread of 10+ messages — the four shapes Phases 1-2 verify against.
      Do not provision these by mailing a third party.
- [ ] Confirm you can see the Gmail **Drafts** folder for that account on a
      phone or in a browser — Phase 4's observable bar is a draft appearing
      there.
- [ ] Confirm the user's own address is reachable for Phase 5/7's single
      live send (the account sends to itself). **No live test in this plan
      ever sends mail to a third party.**

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Follows the same sibling-worktree convention `05-google-sheets` and
`06-legible-approvals-bounded-reads` used. **Not a vertical-slice unit and
not the plan's one permitted infra-only phase** — `.claude/skills/
plan-sequential/SKILL.md` mandates Phase 0 as worktree creation for every
plan, with no Risk/Mode/Type/success-criteria fields, so it is exempt from
the acid test rather than an unjustified exception to it. The actual "does
this plan use its one allowed infra-only phase" question is answered in
Phase 1 below, and the answer there is no.

**Steps:**

- [ ] Confirm with the user: branch name `feat/09-gmail-read-then-send`,
      base ref `main`
- [ ] `git worktree add ../hermes-09-gmail -b feat/09-gmail-read-then-send main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-09-gmail/.env`) — gitignored, so the worktree
      starts without it, and without it the Google env group is invisible to
      the app
- [ ] Check whether the parallel Calendar plan has already landed on `main`;
      if so, note which of the five contended surfaces above are already
      generalized so Phase 1's idempotent steps can be ticked as
      already-done rather than re-performed

---

### Phase 1: `/connect google gmail` + `gmail_list_unread` — the bot can read your inbox

**Risk:** medium
**Mode:** hil
**Type:** backend
**Success criteria:** A user runs `/connect google gmail`, completes consent,
and asks in Telegram "¿tengo algo sin leer?" — the bot answers with real
senders, subjects, dates and unread/important flags from the real mailbox. A
user who has only ever run `/connect google` (identity) asks the same thing
and gets a refusal naming `/connect google gmail`, **with no Gmail API call
made at all**. This phase deliberately folds the package scaffold into the
first vertical slice rather than spending a phase on it: after this commit
there is a new package *and* a new observable capability, so the
"one thin infra-only phase" exception is not used at all.
**Commit message:** `feat: @hermes/google-gmail package, /connect google gmail, gmail_list_unread`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-gmail/package.json` | mirrors `packages/google-sheets/package.json` exactly: `@hermes/google-gmail`, `private`, `type: module`, `main`/`types` → `dist`, scripts `typecheck`/`build` (tsup, esm, dts, `--target node22`)/`test` (`vitest run`), dependencies `@hermes/core: workspace:*` + `zod: ^3.25.0` only, no devDeps |
| create | `packages/google-gmail/tsconfig.json` | the same 7 lines as `packages/google-sheets/tsconfig.json` — extends `../../tsconfig.base.json`, `outDir: dist`, `include: ["src"]`. No `vitest.config.*` (this repo has none anywhere; vitest defaults only) |
| modify | `tsconfig.base.json` | add `"@hermes/google-gmail": ["packages/google-gmail/src/index.ts"]` to `paths`, after the `@hermes/google-sheets` entry. `pnpm-workspace.yaml` already globs `packages/*` — no edit there |
| modify | `apps/hermes/package.json` | add `"@hermes/google-gmail": "workspace:*"` to dependencies |
| create | `packages/google-gmail/src/gmail-client.ts` | `createGmailClient({ fetchImpl? }): GmailClient` over `@hermes/core`'s `withHttpRetry`, modeled line-for-line on `sheets-client.ts`: `GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"`, `REQUEST_TIMEOUT_MS = 10_000`, `MAX_RATE_LIMIT_RETRIES`/`MAX_TRANSIENT_RETRIES = 5`, a `redact(value, accessToken)` that strips the bearer token from every error string, `class GmailApiError extends Error { status; retryAfter? }`, and a `classify` returning `"rateLimit"` (429, honoring `Retry-After`) / `"transient"` (5xx, network) and **throwing** anything else — notably 401/403, which must never be retried. This phase's methods: `listMessages(accessToken, query, maxResults, signal)` (`users.messages.list` with `q`/`labelIds`) and `getMessageMetadata(accessToken, id, signal)` (`users.messages.get` with `format: "metadata"` + `metadataHeaders=From,To,Subject,Date,Message-ID` — headers only, no body, so this phase ships zero MIME code) |
| create | `packages/google-gmail/src/access-token-port.ts` | this package's own `AccessTokenPort` interface, declared here per the consumer-declares-its-port convention (`packages/google-sheets/src/access-token-port.ts` is the model, doc comment and all) — `packages/google-gmail` imports neither `@hermes/google-auth` nor `@hermes/store` |
| create | `packages/google-gmail/src/tools/tool-deps.ts` | `GmailToolDeps { accessTokenPort; gmailClient }` — **two** ports, not three: there is no registry, because there is no reach-gate to enforce (settled decision 7). Plus a duplicated `GmailToolContext` mirroring `@hermes/agent`'s handler ctx (`{ signal, channel, channelUserId, turnId }`), same consumer-declares convention `SheetsToolContext` uses |
| create | `packages/google-gmail/src/insufficient-scope.ts` | `toInsufficientScopeResult(error, scope, fix)` — maps a caught `GmailApiError` with status 401/403 to `{ ok: false, reason: "insufficient_scope", scope, fix }`, the **same field shape** `withRequiredScopes` returns for the pre-call gate, so the model has one refusal vocabulary. Returns `undefined` for any other error so the caller rethrows. Shared by all seven tools from here on |
| create | `packages/google-gmail/src/tools/gmail-list-unread.ts` | `createGmailListUnreadTool(deps)`: top-level `z.object({ maxResults: z.number().int().min(1).max(25).default(10) })`, `timeoutMs: 30_000`, `requiresApproval: false`; lists `labelIds: ["UNREAD", "INBOX"]`, fetches metadata for each, returns `{ ok: true, messages: [{ id, threadId, from, subject, date, unread, important }] }`. Handler catches `GmailApiError` through `toInsufficientScopeResult`. No body, no snippet parsing this phase |
| create | `packages/google-gmail/src/index.ts` | explicit named re-exports only (types via `export type`), matching `packages/google-sheets/src/index.ts`'s style |
| modify | `packages/google-auth/src/scopes.ts` | **append-shaped, contended with Calendar:** new const block `GMAIL_READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]` (the `gmail-send` tier's consts land in Phase 3); one `if (normalized === "gmail") return [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES];` line in `resolveConnectScopes` before `return undefined`; one `["gmail_list_unread", GMAIL_READ_SCOPES]` row appended to `TOOL_REQUIRED_SCOPES` before the closing `]);` |
| modify | `packages/google-auth/src/index.ts` | export `GMAIL_READ_SCOPES` |
| modify | `apps/hermes/src/handlers/connect.ts` | `USAGE_TEXT` gains the Gmail form: `"Usage: /connect google, /connect google sheets, or /connect google gmail"`. Argument parsing itself is unchanged — `resolveConnectScopes` already owns the mapping, and an unknown argument already falls back to usage help |
| modify | `apps/hermes/src/agent/with-required-scopes.ts` | **idempotent, contended with Calendar:** generalize `describeConnectCommand` (`:57`) from its hardcoded Sheets/identity `if` into a small ordered table of `{ scopes, command }` entries checked in order, falling back to `"run /connect google"`. Add the Gmail read row. If the Calendar plan already generalized it, add only the row |
| modify | `apps/hermes/src/google/build-access-token-port.ts` | **idempotent, contended:** declare the port's shape locally (`GoogleAccessTokenPort`) instead of importing `AccessTokenPort` from `@hermes/google-sheets`; reword the "Sheets access token" throw to "Google access token". Behavior — one `RefreshCoordinator`, UPDATE-only `updateRefreshedTokens` on reference-inequality — unchanged |
| modify | `apps/hermes/src/boot.ts` | add `buildGmailDeps(pool, googleAccountRepo, coordinator): GmailToolDeps`, the direct twin of `buildSheetsDeps` (`:746-765`) including its **throwing stub** when the Google env group is unset ("Gmail is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/TOKEN_ENCRYPTION_KEY unset)") so Gmail tools stay wired and cleanly refuse rather than being absent; construct it beside `sheetsDeps` (`:533`) from the **same** shared `refreshCoordinator`, and pass it into `buildAgent` |
| modify | `apps/hermes/src/agent/build-agent.ts` | **append-shaped, contended:** import `createGmailListUnreadTool`/`GmailToolDeps`; `buildAgent` gains a `gmailDeps` parameter (appended before the defaulted `logger`); build `gmailListUnreadTool` via `withRequiredScopes("gmail_list_unread", { googleAccountRepo, requiredScopes: requiredScopesFor("gmail_list_unread") })`; append it to the **end** of the `tools` array — existing prefix bytes untouched (ROADMAP invariant 6) |
| create | `packages/google-gmail/README.md` | package purpose, the two-tier scope posture, the no-registry rationale, the client's retry/timeout/redaction contract, and the tool list as it grows |
| modify | `apps/hermes/README.md` | document `/connect google gmail` and the Gmail tool surface as it grows |

**Steps:**

- [x] Scaffold the package by **copying `packages/google-sheets`' manifest,
      tsconfig and file layout**, then deleting what doesn't apply — do not
      author a new package shape from scratch (CLAUDE.md: inspect a similar
      existing implementation before introducing a new pattern)
- [x] Confirm `pnpm install` links the new workspace package and
      `pnpm -r build` produces `packages/google-gmail/dist/index.js` — the
      runtime resolves `main` → `dist`, so nothing works until this is true
- [x] Write the client's `classify` so 401/403 **throws** rather than
      returning a retry class — assert with a test that a 403 causes exactly
      one `fetchImpl` call, no backoff, no retry
- [x] Assert the access token never appears in any thrown message: build an
      error path with a real token string and grep the message in the test
- [x] `describeConnectCommand`: write the test for all three (soon four)
      tiers *before* touching it, and confirm the existing Sheets and
      identity strings come back byte-identical after the generalization
- [x] Confirm `requiredScopesFor("gmail_list_unread")` resolves — the
      `TOOL_REQUIRED_SCOPES` lookup **throws at construction** if a tool is
      missing (`build-agent.ts:96-102`), so a forgotten row fails boot, not a
      call
- [x] Confirm the tool array's existing prefix is byte-identical and the new
      tool is appended last
- [x] Run the existing `apps/hermes/src/agent/__tests__/tool-schemas.test.ts`
      guard unchanged and confirm the new schema passes its top-level-object
      check

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-gmail/src/__tests__/gmail-client.test.ts` | `fetchImpl` stubbed with real `Response` objects: exact request URL and `Authorization` header for `listMessages`/`getMessageMetadata`; a 429 with `Retry-After` retries and honors the header (`vi.useFakeTimers()`); a 500 retries within its bound; **a 401 and a 403 each throw immediately with zero retries**; the access token never appears in a thrown message |
| create | `packages/google-gmail/src/__tests__/insufficient-scope.test.ts` | a 401 and a 403 `GmailApiError` map to the `{ok:false, reason:"insufficient_scope", scope, fix}` shape; any other error returns `undefined` (caller rethrows) |
| create | `packages/google-gmail/src/tools/__tests__/gmail-list-unread.test.ts` | happy path projects sender/subject/date/flags from a fixture payload; `maxResults` default and clamp; an empty inbox returns `{ok:true, messages: []}`, never an error; a client 403 surfaces as the structured refusal, not a throw |
| create | `packages/google-auth/src/__tests__/scopes.test.ts` (extend if present) | `resolveConnectScopes("gmail")` returns identity + read; `"Gmail"`/`" gmail "` normalize; an unknown argument still returns `undefined`; `TOOL_REQUIRED_SCOPES` has the `gmail_list_unread` row |
| modify | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | `describeConnectCommand`'s table: identity-only → `run /connect google`, Sheets → `run /connect google sheets` (unchanged regression), Gmail read → `run /connect google gmail` |
| modify | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | the tools array contains the Gmail tool, appended last, existing prefix unchanged |

**What is unit-tested vs. what needs live verification (this phase):**
unit-tested with fixtures and a stubbed `fetchImpl`, **no network**: client
URL/headers/retry/redaction, the 401/403 no-retry rule, the
`insufficient_scope` mapping, the tool's projection and defaults, scope
resolution, the connect-command table, tool wiring. **Live, requires a real
mailbox and a human**: the OAuth consent screen actually granting
`gmail.readonly`, and the end-to-end Telegram question returning real
unread mail.

**Verification:**

- [x] `pnpm --filter @hermes/google-gmail test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green (all pass except pre-existing DB-backed suites,
      which fail on `ECONNREFUSED 127.0.0.1:5432` in this environment — no
      local Postgres running; unrelated to `packages/store`, which this phase
      does not touch)
- [x] `pnpm lint` green (fixed 14 pre-existing formatting/import-order
      errors in `packages/google-calendar` + `build-calendar-access-token-port.ts`,
      whitespace-only, 110/110 google-calendar tests still pass)
- [x] `pnpm build` (or restart via `pnpm dev`, which runs `predev`) before any
      manual check — the package is invisible to the running bot otherwise
- [ ] Manual (hil): `/connect google` (identity only) → ask "¿tengo algo sin
      leer?" → the bot relays a refusal naming `/connect google gmail`, and
      the logs show **no** Gmail API call
- [ ] Manual (hil): `/connect google gmail` → complete consent → `/status`
      lists `gmail.readonly` → ask "¿tengo algo sin leer?" → real senders and
      subjects come back
- [ ] Manual (hil): confirm `/connect google` and `/connect google sheets`
      both still behave exactly as before (regression against
      `04-google-auth`/`05-google-sheets` exit criteria)

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
      (the three manual hil checks remain open — see Verification)
- [x] Code-reviewer agent has verified this phase (via `/execute-prd`'s
      subagent dispatch, superseding this template's manual clear-context
      handoff protocol)
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (verdict: green, nits only, no changes required)
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: @hermes/google-gmail package, /connect google gmail, gmail_list_unread`
- [x] Phase marked complete

---

### Phase 2: `gmail_search` + `gmail_read_thread` — mail bodies enter context, bounded

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** The user asks "¿qué me dijo Sarah sobre el viernes?"
and the bot answers from the **actual body text** of a real thread. A
100-message newsletter thread, an HTML-only marketing mail, and a
ten-deep reply chain each come back **bounded** — newest-first, at most ~10
messages, each message's text capped at ~2,000 chars *after* HTML→text
conversion and quoted-reply stripping — with honest
`truncated`/`returnedMessages`/`totalMessages` fields and a Spanish `note`.
An untruncated thread's result is byte-identical to the un-capped shape (no
new keys). This is the phase where mail bodies stop being able to poison
context.
**Commit message:** `feat: gmail_search and gmail_read_thread with own MIME, HTML-to-text, quoted-reply stripping and body bounds`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-gmail/src/mime.ts` | our own, narrow parsing (no library — see Dependencies & Risks): `decodeBase64Url(data): Buffer`, `decodeQuotedPrintable(bytes)` honoring the part's `Content-Transfer-Encoding`, `decodePartText(bytes, contentType): string` — the charset-aware step, reading the `charset` parameter off the part's `Content-Type` header and decoding with `new TextDecoder(charset, {fatal: false})`; an absent, unrecognized, or `TextDecoder`-rejected charset **falls back to UTF-8** rather than throwing, so a malformed `charset=` value degrades to possibly-mangled text, never a tool error, `findBodyPart(payload)` recursively walking `payload.parts` and **preferring `text/plain` over `text/html`** at every level (falling back to the deepest `text/html` when no plain part exists), `readHeader(headers, name)` case-insensitively. Small, individually-named functions, no function over ~30 lines |
| create | `packages/google-gmail/src/html-to-text.ts` | `htmlToText(html)`: strips `<script>`/`<style>` blocks wholesale, converts `<br>`/`</p>`/`</div>`/`</tr>` to newlines, strips remaining tags, decodes the common named + numeric entities, collapses 3+ blank lines to one. Deliberately dumb and deterministic — this is a text-extraction step for a model, not a renderer |
| create | `packages/google-gmail/src/strip-quoted-reply.ts` | `stripQuotedReply(text)`: cuts at the first quote boundary — a line matching the "On … wrote:" / "El … escribió:" attribution patterns, a run of lines beginning `>`, the `-----Original Message-----` separator, or a `--` signature separator with nothing but a signature after it. **Always returns at least the first non-empty paragraph** (never an empty string), because a false-positive boundary that eats the entire message is worse than one that leaves quoted history in |
| create | `packages/google-gmail/src/truncate.ts` | Gmail-local `truncateBySize<T>(items, measure, caps)` mirroring `packages/google-sheets/src/truncate.ts`'s contract exactly (accumulate in order, stop before exceeding either cap, **always keep at least one item**, return `{items, truncated, returnedCount, totalCount}`), with mail-shaped caps `MAX_THREAD_MESSAGES = 10` / `MAX_BODY_CHARS_PER_MESSAGE = 2_000` and a `measureMessage` returning `{messages: 1, chars}`. Package-internal constants, not env-configurable. The deliberate non-promotion to `@hermes/core` and its third-caller trigger are recorded in `.ai/decisions/` (Phase 6) |
| modify | `packages/google-gmail/src/gmail-client.ts` | add `getMessageFull(accessToken, id, signal)` (`users.messages.get` with `format: "full"`) and `getThread(accessToken, threadId, signal)` (`users.threads.get`, `format: "full"`) |
| create | `packages/google-gmail/src/tools/gmail-search.ts` | `createGmailSearchTool(deps)`: `z.object({ query: z.string(), maxResults: z.number().int().min(1).max(25).default(10) })` — `query` is passed to Gmail's own `q` operator syntax (`from:`, `newer_than:`, `has:attachment`), which the tool `description` documents so the model uses it instead of over-fetching. Returns the same bounded metadata projection `gmail_list_unread` returns, plus each message's `snippet`. Ungated, `timeoutMs: 30_000` |
| create | `packages/google-gmail/src/tools/gmail-read-thread.ts` | `createGmailReadThreadTool(deps)`: `z.object({ threadId: z.string() })`. Fetches the thread, **orders newest-first and applies the per-thread message cap before extracting any bodies** (so the fan-out is bounded before the work, not after), then for each kept message: `findBodyPart` → decode → `htmlToText` when the part is HTML → `stripQuotedReply` → per-message char cap via `truncateForPrompt`-style tail-trim. Returns `{ok:true, threadId, subject, messages:[{id, from, to, date, text, bodyTruncated?}], ...(capped.truncated && {truncated:true, returnedMessages, totalMessages, note})}` — additive via conditional spread |
| modify | `packages/google-gmail/src/index.ts` | export the two new tool factories, `truncateBySize`, and the three text utilities (they are the package's genuinely reusable surface) |
| modify | `packages/google-auth/src/scopes.ts` | two appended `TOOL_REQUIRED_SCOPES` rows: `gmail_search`, `gmail_read_thread` → `GMAIL_READ_SCOPES` |
| modify | `apps/hermes/src/agent/build-agent.ts` | two more `withRequiredScopes`-wrapped tools appended to the end of the array |
| modify | `packages/google-gmail/README.md` | document the body pipeline (order of operations is load-bearing: decode → HTML→text → strip quotes → cap), both caps, and the additive-truncation-fields contract |

**Steps:**

- [x] Build the body pipeline as **four separately-testable pure functions**
      composed in the tool, never one `parseMessage` blob — each is
      independently unit-testable against fixtures and independently
      wrong-able (CLAUDE.md: small focused functions, separation of concerns)
- [x] Collect real fixture payloads first: a `text/plain`-only message, a
      `multipart/alternative` with both parts, an HTML-only newsletter, a
      `multipart/mixed` with an attachment part alongside the text, a
      quoted-printable-encoded body, a 10-deep reply chain, and a
      **non-UTF-8 charset body** (e.g. `charset="ISO-8859-1"` or
      `windows-1252`, common on older or auto-forwarded mail). Save them as
      JSON fixtures under `src/__tests__/fixtures/` — **redact real addresses
      and any personal content before committing**
- [x] `decodePartText` must never throw on a malformed or unrecognized
      `charset=` value — construct `TextDecoder` inside a `try`/`catch` and
      fall back to UTF-8, then assert this against a fixture with a bogus
      charset string, not only a missing one
- [x] Apply the per-message cap **after** HTML→text and quote-stripping, not
      before — capping raw HTML would spend the whole budget on markup and
      is the single most likely way to get this wrong
- [x] Apply the per-thread message cap **before** issuing per-message work,
      and confirm with a test that a 100-message thread performs bounded
      work, not 100 messages' worth of parsing
- [x] `stripQuotedReply` must never return empty: write the adversarial test
      (a message whose *first* line matches a quote-boundary pattern) and
      assert the first paragraph survives
- [x] Confirm the untruncated shape is byte-identical to the un-capped one —
      no `truncated` key at all when nothing was dropped
- [x] Confirm the `note` only promises a remedy the tool can honor
      (`.ai/decisions/bounded-tool-results.md`): if `gmail_read_thread` takes
      no offset argument, the note says what was omitted and does not invite
      the model to ask for "the rest"
- [x] Grep the finished tools to confirm **no LLM call and no summarization**
      happens anywhere inside them (settled decision 5)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-gmail/src/__tests__/mime.test.ts` | base64url decode incl. padding-less input; quoted-printable decode incl. soft line breaks; **`decodePartText` decodes a declared non-UTF-8 charset correctly, and falls back to UTF-8 (never throws) for a missing or bogus `charset=` value**; `findBodyPart` prefers `text/plain` in a `multipart/alternative`, descends nested `multipart/mixed`, falls back to HTML when no plain part exists, returns nothing for an attachment-only payload; header lookup is case-insensitive |
| create | `packages/google-gmail/src/__tests__/html-to-text.test.ts` | `<script>`/`<style>` removed with contents; block tags become newlines; entities decoded; blank-line collapse; a plain-text input passes through unchanged |
| create | `packages/google-gmail/src/__tests__/strip-quoted-reply.test.ts` | each boundary pattern (English "On … wrote:", Spanish "El … escribió:", `>`-prefixed run, `-----Original Message-----`, `--` signature); nested quotes cut at the outermost; a message with no quoting is unchanged; **the adversarial always-returns-something case** |
| create | `packages/google-gmail/src/__tests__/truncate.test.ts` | under both caps → all kept, `truncated:false`; over the message cap; over the char cap; a single oversized message returned whole with `truncated:true, returnedCount:1`; empty input → zero counts, `truncated:false` |
| create | `packages/google-gmail/src/tools/__tests__/gmail-search.test.ts` | the `q` string reaches the client verbatim; `maxResults` default/clamp; empty results are `{ok:true, messages:[]}`; a 403 surfaces as `insufficient_scope` |
| create | `packages/google-gmail/src/tools/__tests__/gmail-read-thread.test.ts` | end-to-end over each fixture: plain, HTML-only, quoted chain, quoted-printable; newest-first ordering; the per-thread cap bounds the number of `getMessage` calls (assert the client mock's call count); per-message char cap applied post-strip; untruncated result byte-identical to the un-capped shape; a thread with no readable text part returns a message entry with empty text rather than throwing |

**What is unit-tested vs. what needs live verification (this phase):**
**everything mechanical is unit-tested against fixtures with no network** —
MIME walking, decoding, HTML→text, quote stripping, both caps, ordering,
fan-out bounds, refusal mapping. **Live, requires a real mailbox**: that our
fixtures actually resemble this mailbox's real messages, i.e. one live read
of the HTML newsletter, one of the long quoted chain, and one of the 10+
message thread named in HIL Prerequisites, checking the bot's reply is
coherent and does not visibly contain quoted history or HTML fragments.

**Verification:**

- [x] `pnpm --filter @hermes/google-gmail test` green (86/86)
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green (non-DB suites; DB-backed suites still blocked on no
      local Postgres, pre-existing environment gap, unrelated to this phase)
- [x] `pnpm lint` green
- [x] `pnpm build` before manual checks
- [ ] Manual: ask about a real recent thread and confirm the answer reflects
      body content, not just the subject line
- [ ] Manual: ask about the HTML-only newsletter and confirm the reply
      contains no tags, entities, or CSS
- [ ] Manual: ask about the 10+ message thread and confirm the reply covers
      the newest messages and the model says (or the result shows) that older
      ones were omitted
- [ ] Manual: ask about the long quoted reply chain and confirm the model
      does not re-narrate the same quoted history several times

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
      (the four manual live-mailbox checks remain open — see Verification)
- [x] Code-reviewer agent has verified this phase (via `/execute-prd`'s
      subagent dispatch, superseding this template's manual clear-context
      handoff protocol) — verdict: green, nits only
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (nits noted, no changes required)
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: gmail_search and gmail_read_thread with own MIME, HTML-to-text, quoted-reply stripping and body bounds`
- [x] Phase marked complete

---

### Phase 3: `/connect google gmail-send` + `gmail_archive` + `gmail_label` — the approval gate, proven on reversible actions first

**Risk:** medium
**Mode:** hil
**Type:** backend
**Success criteria:** The user grants the write tier, says "archivá ese
mail", sees a legible Spanish approval prompt naming the thread by subject
and sender, taps **Aprobar**, and the thread leaves the inbox — verifiable in
the Gmail app. Tapping **Rechazar** leaves the mailbox untouched. The same
for "ponele la etiqueta Trabajo". **Landing the reversible mutations before
the irreversible one is the point of this phase**: it exercises the whole
gated path — `prepare` → `ApprovalSummary` → Telegram prompt → tap → handler
→ Gmail — on actions the user can undo with two taps in Gmail if anything is
wrong.
**Commit message:** `feat: /connect google gmail-send, approval-gated gmail_archive and gmail_label`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-auth/src/scopes.ts` | append `GMAIL_WRITE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"]`; one `if (normalized === "gmail-send") return [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES, ...GMAIL_WRITE_SCOPES];` line (the tier re-requests readonly deliberately — see Dependencies & Risks); two appended `TOOL_REQUIRED_SCOPES` rows mapping `gmail_archive`/`gmail_label` to `["https://www.googleapis.com/auth/gmail.modify"]` **only** — not the whole write tier, so a tool's declared requirement stays the minimum it actually needs |
| modify | `packages/google-auth/src/index.ts` | export `GMAIL_WRITE_SCOPES` |
| modify | `apps/hermes/src/handlers/connect.ts` | `USAGE_TEXT` gains the `gmail-send` form |
| modify | `apps/hermes/src/agent/with-required-scopes.ts` | one row in `describeConnectCommand`'s table: anything requiring a `GMAIL_WRITE_SCOPES` member → `"run /connect google gmail-send"` |
| modify | `packages/google-gmail/src/gmail-client.ts` | add `modifyMessage(accessToken, id, { addLabelIds, removeLabelIds }, signal)` (`users.messages.modify`) and `listLabels(accessToken, signal)` (`users.labels.list`, so the tool can resolve a human label name to its id and refuse an unknown one legibly). Both `POST`/`GET` through the same `withHttpRetry` path — **`modify` is idempotent**, so it retries under the same rules reads do |
| create | `packages/google-gmail/src/tools/gmail-archive.ts` | `createGmailArchiveTool(deps)`: `z.object({ threadId: z.string() })`, `requiresApproval: true`, `timeoutMs: 30_000`. `prepare(args, ctx)` fetches the thread's newest message metadata and builds `{ ok: true, plan: { threadId, subject, from }, summary: { action: "¿Archivar esta conversación?", target: subject, effects: ["Sale de Recibidos. Sigue disponible en Todos los mensajes."] } }`; a thread id Gmail 404s refuses **pre-prompt** with `{ok:false, result:{ok:false, reason:"thread_not_found"}}`. Handler removes `INBOX` via `modifyMessage`, reading `ctx.plan` rather than re-resolving |
| create | `packages/google-gmail/src/tools/gmail-label.ts` | `createGmailLabelTool(deps)`: **flat object plus enum**, never a root union (`.ai/decisions/tool-arg-schema-top-level-object.md`): `z.object({ threadId: z.string(), label: z.string(), action: z.enum(["add","remove"]).default("add") })`. `prepare` resolves the label name to an id via `listLabels`, refusing an unknown label pre-prompt with `{ok:false, reason:"unknown_label", available:[…]}` (the shape `resolve-sheet.ts`'s `unknown_sheet` established), and builds an action-specific Spanish `summary`. Handler applies the resolved id from `ctx.plan` |
| modify | `packages/google-gmail/src/index.ts` | export the two factories and their plan types |
| modify | `apps/hermes/src/agent/build-agent.ts` | two gated tools appended, wrapped `withRequiredScopes<GmailArchivePlan>(...)` / `<GmailLabelPlan>(...)` the way `sheetsWriteTool` is (`build-agent.ts:150-153`) — the decorator already forwards and scope-gates `prepare` |
| modify | `packages/google-gmail/README.md`, `apps/hermes/README.md` | the write tier, the two gated tools, their prompt shapes |

**Steps:**

- [x] Write `prepare` so **every** refusal it can produce (unknown label,
      missing thread, missing scope via the decorator) happens **before** the
      prompt — a user must never be asked to approve something already
      destined to fail (`.ai/decisions/tool-prepare-hook.md`; the same
      correctness bar `06-legible-approvals-bounded-reads` Phase 4 set for
      `read_only_sheet`)
- [x] Exact-string tests for both prompts against a hand-built
      `ApprovalSummary` — the renderer
      (`apps/hermes/src/agent/approval-prompt-renderer.ts`) needs **zero
      changes** this phase; if it appears to need one, the summary is wrong,
      not the renderer (confirmed untouched in the diff)
- [x] Confirm the batch entry sent to `requestApproval` carries the model's
      **raw** args, not the parsed ones — the loop already guarantees this;
      the step is to not accidentally depend on the parsed form
- [x] Confirm denial and timeout leave the mailbox untouched: the handler
      must never be reached (spy asserted called zero times)
- [x] Confirm `modifyMessage` is genuinely idempotent in our usage (adding an
      already-present label, archiving an archived thread) and that a repeat
      is a harmless no-op — this is the evidence backing the
      no-durable-log decision recorded in Phase 6
- [x] Verify at execution time which scope Gmail actually requires for
      `users.messages.modify` and `users.labels.list` against Google's
      per-method scope table, and correct `TOOL_REQUIRED_SCOPES` if it
      differs from `gmail.modify` — confirmed `gmail.modify` covers both by
      inspection of Google's docs (code-review nit: not yet cross-checked
      against a live 403, only against documentation — do so during the
      Manual (hil) verification below)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-gmail/src/tools/__tests__/gmail-archive.test.ts` | `prepare` returns the plan+summary for a real thread; a missing thread refuses pre-prompt with no `modifyMessage` call; handler removes exactly `INBOX` and reads `ctx.plan` (client resolve mock called once, not twice); a 403 surfaces as `insufficient_scope` |
| create | `packages/google-gmail/src/tools/__tests__/gmail-label.test.ts` | label-name → id resolution; unknown label refuses pre-prompt listing available labels; `add` vs `remove` produce distinct summaries and distinct `modifyMessage` payloads; schema is a flat object with an enum field |
| modify | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` | the two new summaries render through the **unchanged** generic renderer — added cases only, existing assertions untouched |
| modify | `packages/google-auth/src/__tests__/scopes.test.ts` | `resolveConnectScopes("gmail-send")` returns identity + read + modify + send; the two new `TOOL_REQUIRED_SCOPES` rows name `gmail.modify` only |
| modify | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | a `gmail.modify`-requiring tool's `fix` string is `run /connect google gmail-send`; Sheets/identity strings unchanged |

**What is unit-tested vs. what needs live verification (this phase):**
unit-tested, no network: both `prepare`s including every pre-prompt refusal,
summary content, handler payloads, idempotent-modify semantics against a fake
client, scope resolution and the connect-command row, renderer output.
**Live, requires a real mailbox and a human**: the consent screen granting
the write tier, `/status` showing `gmail.readonly` **literally present**
alongside modify/send (the normalization risk in Dependencies & Risks), and
one real archive plus one real label applied and then undone by hand in
Gmail.

**Verification:**

- [x] `pnpm --filter @hermes/google-gmail test` green (102/102)
- [x] `pnpm -r typecheck` green, `pnpm -r test` green (non-DB suites; 2 DB
      integration tests still blocked on no local Postgres, pre-existing,
      unrelated), `pnpm lint` green
- [x] `pnpm build` before manual checks
- [ ] Manual (hil): `/connect google gmail-send` → consent → `/status` lists
      `gmail.readonly`, `gmail.modify`, `gmail.send`. **If `gmail.readonly`
      is absent, run `/connect google gmail` once and re-check** — record
      which happened in this plan file, it decides whether the contingency in
      Dependencies & Risks was needed
- [ ] Manual (hil): "archivá el último mail de X" → prompt names the subject
      → **Rechazar** → confirm nothing moved in Gmail
- [ ] Manual (hil): repeat → **Aprobar** → confirm the thread left Recibidos
      and is still in Todos los mensajes; un-archive it by hand
- [ ] Manual (hil): "ponele la etiqueta Trabajo a ese hilo" → Aprobar →
      confirm in Gmail; then an unknown label name → confirm **no prompt at
      all** and the model relays the available labels
- [ ] Manual: confirm the three read tools still work unchanged

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
      (the five manual hil live-mailbox checks remain open — see Verification)
- [x] Code-reviewer agent has verified this phase (via `/execute-prd`'s
      subagent dispatch, superseding this template's manual clear-context
      handoff protocol) — verdict: green, nits only
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file (nits noted, no changes required)
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: /connect google gmail-send, approval-gated gmail_archive and gmail_label`
- [x] Phase marked complete

---

### Phase 4: `gmail_draft_reply` — a real Gmail draft you read before it exists

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** "Respondele a Sarah que el viernes me sirve" produces a
Telegram approval prompt containing **the actual reply text that will be
saved**, its recipient, and its subject. On **Aprobar**, a real draft appears
in the Gmail Drafts folder, correctly threaded under the original
conversation, with accented Spanish rendering correctly in both subject and
body. **Nothing is sent.** Saying "cambiá 'el viernes' por 'el lunes'" in the
next message updates that same draft (same `draftId`) rather than creating a
second one — with no new inbound-reply-correlation machinery: it is an
ordinary fresh turn in which the model calls the tool again with the
`draftId` it already has in the thread history.
**Commit message:** `feat: gmail_draft_reply creating and updating real Gmail drafts behind the approval gate`

**This tool requires the write tier — it cannot exist behind read-only.**
`drafts.create`/`drafts.update` need `gmail.modify`, which is a
`GMAIL_WRITE_SCOPES` member and is only ever granted by `/connect google
gmail-send` (Phase 3), never by `/connect google gmail`. So a user who only
ever ran the read-tier connect gets the same `insufficient_scope` refusal for
"respondele que sí" that they would for "archivá ese mail" — drafting is
exactly as gated as sending is *reachable*, even though drafting itself is
reversible. This is why Phase 4 lands after, not before, Phase 3: the write
tier already exists in the token model by the time `gmail_draft_reply` is
registered, so this phase adds no new scope tier of its own (see its
`scopes.ts` row below, which appends to `TOOL_REQUIRED_SCOPES`, not to
`resolveConnectScopes`).

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-gmail/src/build-mime-message.ts` | our own RFC 2822 composer: `buildMimeMessage({ from, to, subject, body, inReplyTo?, references? }): string` → base64url-encoded raw message. `Subject` goes through `encodeHeaderWord` (RFC 2047 `=?UTF-8?B?…?=`) **whenever it contains non-ASCII** — the default case for Spanish, not an edge case; body is `Content-Type: text/plain; charset="UTF-8"` with `Content-Transfer-Encoding: base64`; CRLF line endings; header values sanitized so a newline in a subject can never inject a header |
| modify | `packages/google-gmail/src/gmail-client.ts` | add `createDraft(accessToken, { threadId, raw }, signal)` (`users.drafts.create`), `updateDraft(accessToken, draftId, { threadId, raw }, signal)` (`users.drafts.update`) and `getDraft(accessToken, draftId, signal)` |
| create | `packages/google-gmail/src/tools/gmail-draft-reply.ts` | `createGmailDraftReplyTool(deps)`: `z.object({ threadId: z.string(), body: z.string(), draftId: z.string().optional() })` — a present `draftId` updates that draft, absent creates one. `requiresApproval: true`, `timeoutMs: 30_000`. `prepare` reads the thread's newest message to derive recipient, `Re:` subject and `In-Reply-To`/`References`, and returns `plan: { threadId, draftId?, to, subject, inReplyTo, references, raw }` plus `summary: { action: "¿Guardar este borrador de respuesta?" (or "¿Actualizar el borrador?"), target: "Para: <to> — <subject>", items: [the body, whitespace-collapsed and preview-capped], itemsTotal, effects: ["Se guarda como borrador en Gmail. No se envía nada todavía."] }`. **The handler builds nothing itself** — it posts `ctx.plan.raw`, so the bytes approved are the bytes saved. Returns `{ok:true, draftId, to, subject, body}` |
| modify | `packages/google-auth/src/scopes.ts` | one appended row: `gmail_draft_reply` → `["https://www.googleapis.com/auth/gmail.modify"]` (verify against Google's per-method table; `drafts.create` may accept `gmail.compose` instead — use the scope the write tier actually grants) |
| modify | `apps/hermes/src/agent/build-agent.ts` | one gated tool appended |
| modify | `packages/google-gmail/README.md` | the draft-as-safety-mechanism model, the edit-by-replying flow (no correlation mechanism), the RFC 2047/threading requirements |

**Steps:**

- [ ] Compose the `raw` message **inside `prepare`** and thread it to the
      handler on `ctx.plan` — this is the load-bearing detail of the whole
      phase: it makes "the human approved exactly these bytes" structurally
      true rather than a convention, exactly as
      `.ai/decisions/tool-prepare-hook.md` intends
- [ ] Test the accented-subject path explicitly (`Re: Confirmación`) — assert
      the encoded-word form, and decode it back in the test
- [ ] Test header injection: a body or subject containing `\r\n` must not
      produce extra headers
- [ ] Assert both threading mechanisms are present: the `threadId` field on
      the draft resource **and** `In-Reply-To`/`References` headers
- [ ] Assert the update path targets the same `draftId` and does **not**
      create a second draft (client mock: `createDraft` called zero times)
- [ ] Confirm the approval prompt shows the body text through the generic
      renderer's `items` mechanism with no renderer change
- [ ] Confirm the tool cannot send: grep the finished file for `drafts.send`
      / `messages.send` and assert none appears (a cheap, honest guard for
      the phase whose whole claim is "still not irreversible")

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-gmail/src/__tests__/build-mime-message.test.ts` | ASCII subject passes through unencoded; non-ASCII subject is RFC 2047 encoded and round-trips; body base64/UTF-8 round-trips; CRLF endings; `In-Reply-To`/`References` present when supplied; header-injection attempt is neutralized |
| create | `packages/google-gmail/src/tools/__tests__/gmail-draft-reply.test.ts` | `prepare` derives recipient/subject/threading from a thread fixture; summary contains the body preview; create path calls `createDraft` with `ctx.plan.raw`; update path calls `updateDraft` with the given `draftId` and never `createDraft`; a missing thread refuses pre-prompt; a 403 surfaces as `insufficient_scope`; **the handler never recomposes the message** (assert the raw it posts is identical to the one `prepare` produced) |
| modify | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` | the draft summary renders through the unchanged renderer (added case) |

**What is unit-tested vs. what needs live verification (this phase):**
unit-tested, no network: MIME composition incl. RFC 2047 and injection
safety, threading headers, create-vs-update dispatch, prepare/plan/handler
byte-identity, refusals, prompt rendering. **Live, requires a real mailbox**:
a draft actually appearing in the Gmail Drafts folder, threaded under the
right conversation, with accents intact in a real Gmail client — none of
which any fixture can prove. **No mail leaves the account in this phase.**

**Verification:**

- [ ] `pnpm --filter @hermes/google-gmail test` green
- [ ] `pnpm -r typecheck` green, `pnpm -r test` green, `pnpm lint` green
- [ ] `pnpm build` before manual checks
- [ ] Manual: "respondele a <un hilo real> que el viernes me sirve" → prompt
      shows the recipient, subject and body → **Aprobar** → open Gmail and
      confirm the draft exists, is threaded correctly, and reads correctly
      **including accents**
- [ ] Manual: reply "cambiá el viernes por el lunes" → approve → confirm the
      **same** draft updated and no second draft appeared
- [ ] Manual: trigger a draft and **Rechazar** → confirm no draft was created
- [ ] Manual: confirm the Drafts folder contains no unexpected extra drafts
      after all of the above

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: gmail_draft_reply creating and updating real Gmail drafts behind the approval gate`
- [ ] Phase marked complete

---

### Phase 5: `gmail_send_draft` — the one irreversible step, with a durable send log

**Risk:** ultra-high
**Mode:** hil
**Type:** security
**Success criteria:** The user says "envialo", sees an approval prompt naming
the recipient and subject of the **exact** draft that will go out, taps
**Aprobar**, and the mail actually arrives — **in this plan's verification,
always at the user's own address**. Tapping **Rechazar**, letting the prompt
time out, or restarting the process mid-prompt all produce the same outcome:
**nothing is sent, and the draft is still in Gmail**. After a restart, a tap
on the now-dead button answers definitively — "no se envió nada, el borrador
sigue guardado — pedime «envialo» de nuevo" — instead of today's ambiguous
"esta aprobación ya expiró". A duplicate same-turn call never sends twice; a
genuinely ambiguous API failure hedges instead of retrying.
**Commit message:** `feat: approval-gated gmail_send_draft with durable gmail_send_log and definite post-restart reporting`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/0NN_gmail_send_log.sql` | **pick the next free number at execution time** (see contention note). Modeled on `009_sheet_write_log.sql`: `dedupe_key text PRIMARY KEY`, `channel`, `channel_user_id`, `turn_id`, `tool`, `canonical_args jsonb`, `draft_id text NOT NULL`, `status text NOT NULL CHECK (status IN ('awaiting_approval','pending','complete'))`, `outcome jsonb`, `created_at timestamptz NOT NULL DEFAULT now()`, `completed_at timestamptz`, plus an index on `(channel, channel_user_id, created_at DESC)` for the post-restart lookup. Comment header states, in the SQL itself, that a row is an **intent record and never a grant** |
| create | `packages/store/src/gmail-send-log-repo.ts` | `recordIntent(pool, dedupeKey, input)` — `INSERT … ON CONFLICT DO NOTHING`, status `awaiting_approval`; `claim(pool, dedupeKey, input)` — `UPDATE … SET status='pending' WHERE dedupe_key=$1 AND status='awaiting_approval' RETURNING`, else `SELECT` and return **the same three outcomes `sheet-write-log-repo.ts` returns**: `"claimed"` / `{alreadyComplete:true, outcome}` / `{alreadyPending:true}` (a missing row defensively inserts as `pending` and claims); `complete(pool, dedupeKey, outcome)`; `release(pool, dedupeKey)` — `DELETE … WHERE dedupe_key=$1 AND status='pending'`, the same guard that cannot race a legitimate complete; `findLatestIntent(pool, channel, channelUserId, sinceMs)` for the post-restart report |
| modify | `packages/store/src/index.ts` | export the five as `recordGmailSendIntent`/`claimGmailSend`/`completeGmailSend`/`releaseGmailSend`/`findLatestGmailSendIntent`, mirroring the `*SheetWrite` naming |
| create | `packages/google-gmail/src/canonical-args.ts` | the same deterministic `canonicalizeArgs` + `computeDedupeKey(sha256 over [channel, channelUserId, turnId, tool, canonicalArgsJson])` `packages/google-sheets/src/canonical-args.ts` implements. **`turnId` is in the key on purpose** — a retry guard within the turn that produced the call, never a permanent block on ever sending that draft again. Duplicated rather than promoted for the same third-caller reason as `truncate.ts` (recorded in Phase 6) |
| create | `packages/google-gmail/src/tools/gmail-send-draft.ts` | `createGmailSendDraftTool(deps)`: `z.object({ draftId: z.string() })`, `requiresApproval: true`, `timeoutMs: 30_000`. **`prepare`**: fetches the draft (`getDraft`), refuses pre-prompt if it no longer exists (`{ok:false, reason:"draft_not_found"}`), builds `plan: { draftId, to, subject }` and `summary: { action: "¿Enviar este correo?", target: "Para: <to> — <subject>", items:[body preview], effects:["Se envía de verdad. Esto no se puede deshacer."] }`, then calls `sendLogRepo.recordIntent(...)` — an **intent**, not consent. **Handler**: `claim` → `"claimed"` proceeds; `alreadyComplete` returns the stored outcome with **no second API call**; `alreadyPending` returns `{ok:false, reason:"ambiguous_send", message:"puede que ya se haya enviado — revisá Enviados antes de reintentar"}` and **writes nothing**; then `drafts.send`; on success `complete(dedupeKey, outcome)`; on a **provably definitive** failure (non-429 4xx, exhausted 429) `release(dedupeKey)` and return the structured refusal; on **anything ambiguous** (post-send timeout, 5xx after the request left, malformed body after a 2xx) keep the pending row and return `ambiguous_send` |
| modify | `packages/google-gmail/src/gmail-client.ts` | add `sendDraft(accessToken, draftId, signal)` (`users.drafts.send`) with its own `classifySend` that mirrors `sheets-client.ts`'s `classifyWrite`: a 429 is safe to retry (rejected before applying), **a post-send network failure or 5xx is never silently retried** — it throws a `GmailAmbiguousSendError` the tool converts into the hedge |
| modify | `packages/google-auth/src/scopes.ts` | one appended row: `gmail_send_draft` → `["https://www.googleapis.com/auth/gmail.send"]` (verify `drafts.send`'s exact accepted scopes at execution time) |
| modify | `apps/hermes/src/agent/telegram-approval-gate.ts` | `createTelegramApprovalGate` gains an **optional** `describeExpiredApproval?: (channel: string, channelUserId: string) => Promise<string \| undefined>`; the `pending.get()` miss branch (`:153-156`) awaits it inside a `try`/`catch` and uses its string when defined, otherwise the existing `EXPIRED_CALLBACK_TEXT` **byte-identical**. No other resolution path changes; nothing here ever executes a tool |
| modify | `apps/hermes/src/boot.ts` | `buildGmailSendLogRepo(pool)` inline-object binder next to `buildSheetWriteLogRepo` (`:777-784`), same shape; bind `describeExpiredApproval` to a `findLatestGmailSendIntent` lookup rendering the definite Spanish sentence; thread both into `buildAgent` |
| modify | `apps/hermes/src/agent/build-agent.ts` | one gated tool appended, taking `{ ...gmailDeps, sendLogRepo }` the way `sheetsWriteTool` takes `sheetWriteLogRepo`; pass `describeExpiredApproval` into `createTelegramApprovalGate` |
| modify | `packages/store/README.md`, `packages/google-gmail/README.md`, `apps/hermes/README.md` | the table's lifecycle and the intent-is-not-a-grant invariant; the ambiguous-send hedge; the post-restart reporting behavior |

**Steps:**

- [ ] **Write the invariant test first:** there is no code path from a stored
      `gmail_send_log` row to a Gmail API call. Assert it structurally — the
      approval gate's expired branch must reach only `findLatestIntent` and
      the channel's `answerCallback`, never the tool, the client, or
      `claim` — and grep the diff for any new call to `sendDraft` outside the
      tool handler
- [ ] Confirm `recordIntent` at `prepare` time cannot be mistaken for a
      claim: it writes `awaiting_approval`, and `claim` only ever transitions
      **from** that state or inserts fresh; a row in `awaiting_approval` is
      never a short-circuit for anything
- [ ] Implement the definitive-vs-ambiguous split **before** wiring the
      happy path, and test each branch against a fake client: 400 →
      released + definite refusal; exhausted 429 → released + definite
      refusal; post-send timeout → row stays `pending`, `ambiguous_send`;
      5xx after send → row stays `pending`, `ambiguous_send`
- [ ] Test the three claim outcomes end to end through the tool, mirroring
      `sheets-write.test.ts`'s existing cases
- [ ] Confirm a denied approval leaves an `awaiting_approval` row and **no**
      send — and that the row's only effect is that a later expired-tap
      report says nothing was sent (which is true)
- [ ] Confirm the expired-describer failing (thrown, DB down) falls back to
      the existing text and never breaks the tap handler
- [ ] Confirm no "always allow" affordance was introduced anywhere: grep the
      diff for any persistence of an approval decision, any reuse of a prior
      decision, and any code path where a `gmail_send_log` row causes a send
- [ ] DB suite follows `.ai/decisions/test-database-isolation.md` — import
      the guard via `@hermes/store/testing`, never read
      `TEST_DATABASE_URL` directly
- [ ] Confirm `prepare` fails closed when `recordIntent` itself throws (DB
      unreachable): the generic `.ai/decisions/tool-prepare-hook.md` contract
      already turns any `prepare` throw into `{ok:false,
      reason:"prepare_failed"}` with no prompt shown, so this needs no new
      mechanism — the step is to test it for *this* tool specifically, since
      `recordIntent` is the one Gmail call with a side effect inside
      `prepare`. Confirm `recordIntent`'s `INSERT … ON CONFLICT DO NOTHING`
      is atomic, so a throw mid-call leaves either a clean insert or no row
      at all — never a half-written `awaiting_approval` row a later claim
      could misread

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/store/src/__tests__/gmail-send-log-repo.test.ts` (DB suite, `pnpm test:db`) | `recordIntent` is idempotent on repeat; `claim` returns `"claimed"` from `awaiting_approval`, `{alreadyPending}` for a second claim, `{alreadyComplete, outcome}` after `complete`; `release` deletes a `pending` row and **refuses to delete a `complete` one**; `findLatestIntent` returns the newest row within the window and nothing outside it |
| create | `packages/google-gmail/src/__tests__/canonical-args.test.ts` | key-order-independent canonicalization; identical args in one turn hash identically; a different `turnId` hashes differently |
| create | `packages/google-gmail/src/tools/__tests__/gmail-send-draft.test.ts` | `prepare` records the intent and builds the summary; a vanished draft refuses pre-prompt with **no intent row written**; the three claim outcomes; the definitive-failure release path; both ambiguous paths keep the pending row and return `ambiguous_send`; `alreadyComplete` returns the stored outcome with **zero** client calls |
| modify | `apps/hermes/src/agent/__tests__/telegram-approval-gate.test.ts` | an unknown callback id with a describer returning a string answers that string; with no describer, or one returning `undefined`, or one that throws, answers the existing `EXPIRED_CALLBACK_TEXT` byte-identically; **the describer's presence never causes a tool invocation** |
| modify | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` | the send summary renders through the unchanged renderer |

**What is unit-tested vs. what needs live verification (this phase):**
unit-tested with fakes and the DB lane, **no network**: every claim outcome,
the definitive-vs-ambiguous split, release semantics, the intent lifecycle,
the post-restart describer including all three fallback cases, the summary,
and the structural "no path from a row to a send" assertion. **Live,
requires a human and a real mailbox — exactly one send**: replying to a
thread in the user's own mailbox, addressed to the user's own address, and
confirming it arrives. **Never a third party.** The restart behavior is
verified live too, and cheaply: trigger a send prompt, restart the process
before tapping, then tap — no mail may be sent, and the answer must be the
definite one.

**Verification:**

- [ ] `pnpm --filter @hermes/google-gmail test` green
- [ ] `pnpm --filter @hermes/store test:db` green
- [ ] `pnpm -r typecheck` green, `pnpm -r test` green, `pnpm test:db` green, `pnpm lint` green
- [ ] `pnpm build` before manual checks
- [ ] Manual (hil): draft a reply **to the user's own address**, then
      "envialo" → prompt names recipient and subject → **Rechazar** →
      confirm nothing in Sent, draft still in Drafts
- [ ] Manual (hil): repeat → **Aprobar** → confirm the mail **arrives at the
      user's own address** and appears in Sent
- [ ] Manual (hil): draft again, say "envialo", and **restart the process
      before tapping**; then tap → confirm the answer is the definite Spanish
      sentence, **nothing is sent**, and the draft is still in Drafts
- [ ] Manual (hil): ask to send an already-sent/deleted `draftId` → confirm
      **no prompt at all** and a legible refusal
- [ ] [~] A genuinely ambiguous send (post-send timeout / 5xx after the
      request left) is covered by fake-client unit tests rather than
      provoked against Google — same accepted posture `05-google-sheets`
      recorded for the equivalent write case

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: approval-gated gmail_send_draft with durable gmail_send_log and definite post-restart reporting`
- [ ] Phase marked complete

---

### Phase 6: Documentation and `.ai/` knowledge base sync

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** `.ai/` and every touched README describe the shipped
Gmail behavior, not the pre-plan state or a mid-plan intermediate. The two
cross-cutting claims this plan invalidates — "API-side 401/403 has no re-auth
path" and "a new mutating tool must add durable auditing" — are corrected in
place rather than left to contradict the code. No new code ships in this
phase.
**Commit message:** `docs: sync knowledge base for 09-gmail-read-then-send`

**Why this is a standalone phase, not distributed per-phase (the acid test's
other documented exception, not the infra-only one):** every README touched
by Phases 1-5 already updates **inline, in that phase's own file-changes
table** — `packages/google-gmail/README.md` and `apps/hermes/README.md` are
edited in every one of Phases 1-5, per CLAUDE.md's "update documentation
alongside code changes." What this phase defers is narrower: the four new
`.ai/decisions/` docs and the `index.md`/`architecture.md` rows. Two of those
are load-bearing reasons, not convenience: (1) `sync-knowledge` is designed
as an end-of-plan closeout step, not a per-commit one — writing it mid-plan
would mean re-running it five times over a shrinking diff; (2) the two
amendments this phase makes to *existing* docs — "API-side 401/403 has no
re-auth path" and "a new mutating tool must add durable auditing" — can only
be written correctly once the whole shape they're amending against exists:
the 401/403 correction depends on Phase 5's `insufficient_scope` mapping
actually landing everywhere it applies, and the mutating-tool-auditing
refinement depends on archive/label (Phase 3) and send (Phase 5) *both*
existing so the "irreversible-or-ambiguity-prone" line is drawn against the
real, final set of mutations rather than a partial one that a later phase
might contradict. `06-legible-approvals-bounded-reads` sets the same
precedent — its Phase 8 is the identical standalone docs-sync phase,
immediately before Final Verification.

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `.ai/decisions/gmail-two-tier-scopes.md` | why read and send are separate `/connect` tiers and what that structurally guarantees (and, honestly, stops guaranteeing at Phase 3); why the send tier re-requests `gmail.readonly`; why `TOOL_REQUIRED_SCOPES` stays flat and literal with no implication table; the restricted-scope/CASA prerequisite; rejected: one combined tier, three tiers, scope-implication logic in `hasRequiredScopes` |
| create | `.ai/decisions/gmail-body-bounding.md` | our own MIME/HTML→text/quoted-strip utilities and why no mail library clears CLAUDE.md's two bars; the pipeline order (decode → HTML→text → strip quotes → cap) and why capping before stripping is wrong; the two caps and the additive-fields contract; **the deliberate Gmail-local `truncateBySize`/`canonicalizeArgs` duplication and the third-caller promotion trigger**; rejected: a mail-parsing dependency, promoting to `@hermes/core` at two callers, LLM summarization inside a tool, a dedicated `summarize_inbox` |
| create | `.ai/decisions/gmail-send-intent-log.md` | `gmail_send_log`'s three-state lifecycle and why an intent row is written at `prepare` time when `sheet_write_log` writes nothing before approval; the three claim outcomes and the definitive-vs-ambiguous release rule; **the intent-is-never-a-grant invariant**; the post-restart reporting seam; **the narrowed audit rule — "irreversible or ambiguity-prone ⇒ durable claim + audit, otherwise telemetry" — and why archive/label land on the telemetry side**: `users.messages.modify` is idempotent (a repeat is a no-op, so there is nothing to double-apply and nothing to hedge) and Gmail's own mailbox state is itself the durable, user-inspectable record of what happened; rejected: auto-resume from a button tap, persisted approvals, an always-allow affordance, treating `alreadyPending` as claimable, **logging archive/label the same synchronous claim-and-audit way as send** (no double-apply risk to guard against, so the row would record nothing a human or the mailbox itself doesn't already show), **and async/best-effort logging for the reversible tools** (adds a write path and a retention question for a class of call this repo has already decided, in `read-tool-auditing-deferred.md`, is a forensics nice-to-have rather than a correctness need) |
| create | `.ai/decisions/gmail-api-403-structured-refusal.md` | the first API-side re-auth path in the codebase: 401/403 as a non-retryable typed error mapped to the **same** `{ok:false, reason, scope, fix}` shape `withRequiredScopes` returns; why the model never mints a consent URL; **why a 403 must not disconnect the account** (unlike refresh-time `invalid_grant`) — a per-message or per-scope 403 would otherwise destroy a working Sheets connection |
| modify | `.ai/decisions/read-tool-auditing-deferred.md` | Gmail reads join the deferred set; refine the standing constraint from "a new mutating tool" to "a new **irreversible or ambiguity-prone** mutating tool must add durable auditing on the `sheet_write_log` model", with the archive/label reasoning recorded |
| modify | `.ai/index.md` | new `@hermes/google-gmail` module row (responsibility, path, decision links); `@hermes/google-auth` row gains the Gmail scope tiers; `@hermes/store` row gains `gmail_send_log`; `apps/hermes` row gains `buildGmailDeps` and the expired-approval describer; Cross-cutting **Tool approvals** row gains the send tool and re-states the no-always-allow invariant with the intent-log caveat; Cross-cutting **Google OAuth + token lifecycle** row's "API-side 401/403 has no re-auth path today" claim is corrected; a new Cross-cutting **Gmail access & send safety** row mirroring the Sheets one (scope tier / consent / draft-first / durable send log) |
| modify | `.ai/architecture.md` | add an "Inside a Gmail tool call" flow beside the Sheets one: scope gate → `prepare` (resolve + refuse pre-prompt + record intent for send) → approval prompt → claim → API call → bound/record outcome |
| modify | `packages/google-gmail/README.md` | final pass over the whole package surface |

**Steps:**

- [ ] Edit from the diff, not from this plan — read what actually shipped
      before writing any `.ai/` line
- [ ] Grep the repo for now-false claims: "API-side 401/403", "no re-auth
      path", and any README line implying Sheets is the only capability
      package
- [ ] Run the `sync-knowledge` skill's closing checklist against the
      Knowledge Base Impact table below
- [ ] Confirm no `.ai/` row claims an always-allow mechanism exists or could
      exist, and that the intent-vs-grant distinction is stated where the
      table is described, not only in its decision doc

**Tests:**

No automated tests — justified because: this phase is a pure documentation
change with no behavior to verify; correctness is checked by human review
against the shipped code.

**Verification:**

- [ ] `pnpm -r test` still green (confirms nothing was accidentally touched)
- [ ] Manual: read the new `.ai/decisions/` docs and the `@hermes/google-gmail`
      index row end to end against the shipped code

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing (n/a — see Tests above)
- [ ] Documentation updated (this phase *is* the documentation update)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `docs: sync knowledge base for 09-gmail-read-then-send`
- [ ] Phase marked complete

---

### Phase 7: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- **"¿Hay algo urgente hoy?" gives a real triage** — the bot lists real
  unread mail, reads the one or two threads that look like they matter, and
  says what actually needs attention, in one turn, without a dedicated
  triage tool.
- **"Respondele a Sarah que el viernes me sirve" produces a draft the user
  approves and then sends** — the approval prompt shows the real text, the
  draft appears in Gmail, "envialo" produces a second, separate confirmation,
  and the mail actually goes out (**to the user's own address** in this
  verification).
- A huge thread, an HTML newsletter, and a deep quoted chain all stay
  bounded — the bot never floods its own context and stays coherent
  several messages later.
- A user with only identity, or only the read tier, is refused every write
  tool with a legible Spanish instruction naming the right `/connect`
  command, **and no Gmail API call is made**.
- A revoked-at-Google grant surfaces as `insufficient_scope` with a fix
  string, **and does not disconnect the account** — `/status` still shows
  the Sheets capability, and Sheets tools still work.
- **No always-allow affordance exists anywhere.** Every send is one explicit
  tap. A stored `gmail_send_log` row never authorizes anything.
- No CLAUDE.md invariant violated: no new dependency; `packages/agent`
  imports no feature package; `packages/google-gmail` imports neither
  `@hermes/store` nor `@hermes/google-auth`; the approval prompt is still
  rendered deterministically by our own code, never authored by the model.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are
      ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to
      end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt
      into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final review reflected back into
      this plan file
- [ ] `pnpm -r typecheck` green, `pnpm -r test` green, `pnpm test:db` green,
      `pnpm lint` green, `pnpm build` green
- [ ] No CLAUDE.md invariants violated
- [ ] Manual golden path, on a real phone against the real bot, in order:
      "¿hay algo urgente hoy?" → a real triage → "respondele a <hilo real,
      dirigido a la propia dirección del usuario> que el viernes me sirve" →
      prompt shows the real text → Aprobar → draft visible in Gmail →
      "cambiá el viernes por el lunes" → same draft updated → "envialo" →
      second, separate prompt → Aprobar → **mail arrives at the user's own
      address**
- [ ] Manual: the same send flow but **Rechazar** at the send prompt →
      nothing sent, draft intact
- [ ] Manual: restart mid-send-prompt, then tap → definite answer, nothing
      sent
- [ ] Manual: revoke Gmail access at
      `myaccount.google.com` → a Gmail tool call returns `insufficient_scope`
      with the right `/connect` instruction, the account is **not**
      disconnected, and a Sheets tool still works → re-connect and confirm
      recovery
- [ ] Manual: confirm all `05-google-sheets`/`06-legible-approvals` exit
      criteria still hold (Sheets read/write, legible prompts) — this plan
      touched shared wiring and must not have regressed them
- [ ] [~] Ambiguous-send and in-turn send dedupe remain unit-test-only —
      not provokable against Google, and every inbound Telegram message is a
      new turn — same accepted posture `05-google-sheets` recorded
- [ ] Overall success criteria met
- [ ] `sync-knowledge` re-run to confirm Phase 6's edits are still accurate
      after any Final-Verification-driven fixes
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Package purpose, no-registry rationale, client retry/timeout/redaction | `packages/google-gmail/README.md` |
| Body pipeline (order of operations), both caps, additive truncation fields | `packages/google-gmail/README.md` |
| Two scope tiers, `/connect google gmail` and `/connect google gmail-send` | `packages/google-auth/README.md`, `apps/hermes/README.md` |
| The seven tools, which are gated, and their prompt shapes | `packages/google-gmail/README.md`, `apps/hermes/README.md` |
| Draft-as-safety-mechanism and the edit-by-replying flow | `packages/google-gmail/README.md` |
| `gmail_send_log` lifecycle, claim outcomes, ambiguous-send hedge | `packages/store/README.md`, `packages/google-gmail/README.md` |
| Post-restart expired-approval reporting | `apps/hermes/README.md` |
| `insufficient_scope` refusal shape and the no-disconnect-on-403 rule | `packages/google-gmail/README.md`, `apps/hermes/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `@hermes/google-gmail` module row; `google-auth`/`store`/`apps/hermes` rows updated; Tool-approvals row gains the send tool + intent-vs-grant caveat; Google-OAuth row's "no API-side re-auth path" claim corrected; new Cross-cutting "Gmail access & send safety" row |
| `architecture.md` | update | "Inside a Gmail tool call" flow beside the Sheets one |
| `decisions/gmail-two-tier-scopes.md` | create | the tiering, what it structurally guarantees, flat literal scope map, restricted-scope prerequisite, rejected alternatives |
| `decisions/gmail-body-bounding.md` | create | own text utilities over a library, pipeline order, caps, deliberate local duplication + third-caller promotion trigger, rejected alternatives |
| `decisions/gmail-send-intent-log.md` | create | three-state lifecycle, claim outcomes, definitive-vs-ambiguous release, intent-is-never-a-grant, no auto-resume, why archive/label need no log |
| `decisions/gmail-api-403-structured-refusal.md` | create | first API-side re-auth path; shared refusal vocabulary; why a 403 must not disconnect |
| `decisions/read-tool-auditing-deferred.md` | update | Gmail reads join the deferred set; the mutating-tool constraint refined to irreversible/ambiguity-prone |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | client URLs/headers, retry classes, 401/403 no-retry, token redaction | `packages/google-gmail/src/__tests__/gmail-client.test.ts` |
| Phase 1 | 401/403 → `insufficient_scope` mapping | `packages/google-gmail/src/__tests__/insufficient-scope.test.ts` |
| Phase 1 | `gmail_list_unread` projection, defaults, empty inbox, refusal | `packages/google-gmail/src/tools/__tests__/gmail-list-unread.test.ts` |
| Phase 1 | Gmail scope resolution + `TOOL_REQUIRED_SCOPES` rows | `packages/google-auth/src/__tests__/scopes.test.ts` |
| Phase 1 | generalized `describeConnectCommand` table | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` |
| Phase 2 | MIME walking/decoding, part preference | `packages/google-gmail/src/__tests__/mime.test.ts` |
| Phase 2 | HTML→text | `packages/google-gmail/src/__tests__/html-to-text.test.ts` |
| Phase 2 | quoted-reply stripping incl. never-empty rule | `packages/google-gmail/src/__tests__/strip-quoted-reply.test.ts` |
| Phase 2 | Gmail-local `truncateBySize` caps and edge cases | `packages/google-gmail/src/__tests__/truncate.test.ts` |
| Phase 2 | `gmail_search` query passthrough and bounds | `packages/google-gmail/src/tools/__tests__/gmail-search.test.ts` |
| Phase 2 | `gmail_read_thread` full pipeline, ordering, bounded fan-out, additive fields | `packages/google-gmail/src/tools/__tests__/gmail-read-thread.test.ts` |
| Phase 3 | `gmail_archive` prepare/refusals/handler payload | `packages/google-gmail/src/tools/__tests__/gmail-archive.test.ts` |
| Phase 3 | `gmail_label` resolution, unknown-label pre-prompt refusal, add/remove | `packages/google-gmail/src/tools/__tests__/gmail-label.test.ts` |
| Phase 3-5 | new summaries render through the unchanged generic renderer | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` |
| Phase 4 | RFC 2822/2047 composition, threading headers, injection safety | `packages/google-gmail/src/__tests__/build-mime-message.test.ts` |
| Phase 4 | draft create vs update, prepare-composed raw reaches the handler unchanged | `packages/google-gmail/src/tools/__tests__/gmail-draft-reply.test.ts` |
| Phase 5 | send-log intent/claim/complete/release/lookup (DB lane) | `packages/store/src/__tests__/gmail-send-log-repo.test.ts` |
| Phase 5 | canonical args + dedupe key incl. `turnId` semantics | `packages/google-gmail/src/__tests__/canonical-args.test.ts` |
| Phase 5 | three claim outcomes, definitive-vs-ambiguous split, pre-prompt refusal | `packages/google-gmail/src/tools/__tests__/gmail-send-draft.test.ts` |
| Phase 5 | expired-tap describer incl. all fallbacks, and that it never invokes a tool | `apps/hermes/src/agent/__tests__/telegram-approval-gate.test.ts` |

## Human Summary

This plan teaches the bot to handle email, in the order that keeps it safe:
it learns to **read** your inbox first, and only much later — after the
reading half is built, used, and proven — does it gain any ability to send
anything at all.

That order is enforced by the permissions themselves, not by good
intentions. Connecting with `/connect google gmail` grants read-only access
to your mail, and that is genuinely all the bot can do; there is no
permission in the system to send. Only later, when you run `/connect google
gmail-send`, does the stronger permission exist — and even then, the actual
send button doesn't exist in the code until the last build phase.

The phases go: read your unread mail → read whole conversations properly
(this is where the bot learns to strip out HTML junk and repeated quoted
history so a long email thread can't swamp its memory) → archive and label
things, which are safe because you can undo them in Gmail with two taps →
write a real draft you read in Telegram before it's even saved → and finally
send. Each one is a thing you can actually try in the chat when it lands, not
a layer of plumbing.

The safety story is the draft. When you say "reply to Sarah that Friday
works", the bot shows you the exact text and asks; approving saves it as a
real draft in Gmail. Saying "actually make it Monday" just edits that same
draft. Sending is a completely separate, second confirmation — and it can
never be made automatic: there is no "always allow" anywhere in this system,
and this plan deliberately does not add one. If the bot restarts while a
send confirmation is waiting, nothing is sent, the draft is still sitting in
Gmail, and tapping the old button now tells you exactly that instead of a
vague "expired".

Two smaller trade-offs worth naming. We write our own email parsing rather
than installing a library — the parsing we need is small, and handing
untrusted email to a big third-party parser is a bad trade. And Gmail's
permissions are in Google's strictest category, so running this beyond
personal testing eventually requires a formal Google review; that's flagged
as a real-world prerequisite, not something this plan can solve. Throughout,
the single live send test mails the user's own address — never a real
third party.
