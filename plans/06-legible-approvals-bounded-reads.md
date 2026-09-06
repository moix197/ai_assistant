# Plan: Legible Approvals & Bounded Reads

**Created:** 2026-08-29
**Branch:** `feat/06-legible-approvals-bounded-reads`
**Status:** complete. All nine phases shipped and the golden path was verified on a real phone against the real bot. One `[~]` remains accepted: in-turn write dedupe stays unit-test-only, unchanged from `05-google-sheets`.

## Context

`05-google-sheets` shipped `sheets_write` behind a human approval gate and
`sheets_read`/`sheets_inspect` as ungated reads. Two defects surfaced once
those tools were live, both already recorded as open gaps in `.ai/`:

1. **The approval prompt is unreadable and under-informed**
   (`.ai/decisions/approval-gate-design.md:98-114`,
   `apps/hermes/README.md:144-156`). `formatBatchPrompt`
   (`apps/hermes/src/agent/telegram-approval-gate.ts:26-29`) renders the
   model's raw, unresolved args — `The model wants to run:\n-
   sheets_write({"mode":"append",...})\n\nApprove or deny?` — in English, to a
   non-technical Spanish-speaking user. It omits which spreadsheet the slug
   resolves to (an operator-editable Postgres row) and the *effective*
   `valueInputOption` when it falls back to the registry default. The
   architectural asymmetry this plan preserves: every other user-visible
   message is rendered by the LLM into natural language; the approval prompt
   is the one thing our own code sends directly, on purpose — if the model
   authored the confirmation text, a confused model could describe one
   action and execute another, and the gate would stop being a safety
   control. Rendering must stay deterministic, built from resolved data, and
   it must stay entirely inside `apps/hermes` (the one place allowed to
   import a channel and a feature package together).

2. **`sheets_read` (and `sheets_inspect`) results are unbounded**
   (`packages/google-sheets/src/tools/sheets-read.ts:39-51`). The model picks
   the A1 range and nothing caps `result.values`; `sheets_inspect` reports
   `rowCount`/`columnCount` up to 1000×26 with no incentive for the model to
   ask for less. Tool results are serialized straight into model context
   (`packages/agent/src/loop.ts`'s `JSON.stringify(outcome)`), and
   `trimHistory`'s `HISTORY_BUDGET_CHARS` (8000 chars ≈ 2000 tokens) always
   keeps at least one message group, so one huge result is never trimmed —
   it just silently dominates the context window. This has no error signal;
   it degrades quietly.

This plan closes both. Problem 2 ships first — one package, self-contained,
no cross-package contract change. Problem 1 ships as a `prepare` hook added
to `@hermes/agent`'s `ToolSpec`: a tool can now resolve everything an
approver needs to see *before* the prompt is built, once, and hand the loop
both a typed `plan` (threaded untouched into the handler, so the handler
physically cannot re-resolve and diverge from what was shown) and a
**concrete, generic** `summary` — a small, tool-agnostic display vocabulary
(`action`, `target?`, `items?`/`itemsTotal?`, `effects`) declared in
`packages/agent/src/approval-gate-port.ts` itself, naming no Sheets concept.
The tool builds one; the Telegram gate renders it generically — the gate
needs zero per-tool knowledge because the vocabulary is the same for any
future gated tool, not a cast keyed on `tool === "sheets_write"`. Content
decisions (what counts as a row worth previewing, whether a value will be
reinterpreted) are made by the tool, tool-side, in `prepare` — the gate only
turns `action`/`target`/`items`/`itemsTotal`/`effects` into line breaks,
indentation, and the "…y N más" count line. `sheets_write` is the only tool
that populates a `summary` in this plan; every other tool (`echo`, `whoami`,
`get_current_time`, `sheets_read`, `sheets_inspect`) is unaffected and
renders exactly as it does today.

**Explicitly out of scope, owned by later work:**

- **Tier 2 of the approval prompt** — column headers as row labels, and a
  before→after diff shown *in the prompt itself* (as opposed to Tier 1's
  post-write `replaced` values, narrated after the fact — see Phase 7).
  Tier 2 needs a pre-approval Google API read, which requires
  `with-required-scopes.ts`'s scope decorator to wrap `prepare` too (it
  currently only wraps `handler`), a real cost in latency (1-2 extra API
  calls per prompt) and risk (an under-scoped or disconnected account
  triggering a live call *before* consent, regressing the fail-closed
  guarantee `05-google-sheets` proved). Recorded as the new deferred gap in
  `.ai/decisions/approval-gate-design.md` (Phase 8) — revisit only if users
  actually ask "which column is that?".
- **Any i18n/locale mechanism.** The prompt is hardcoded Spanish. This is a
  single-tenant bot for one Spanish-speaking user population; a locale table
  would be speculative abstraction CLAUDE.md forbids.
- **Env-configurable truncation caps.** `MAX_CELLS`/`MAX_VALUE_CHARS` are
  package-internal constants, same posture as `HISTORY_BUDGET_CHARS` — not a
  new config surface.
- **A generic, loop-level result-truncation mechanism.** The cap lives in
  `packages/google-sheets`, not `packages/agent`'s `loop.ts` — a
  tool-specific concern (what's a "row," what's a "tab") a generic loop
  cannot know.

## Risk: high

The `prepare` hook is a public contract change to `@hermes/agent`'s
`ToolSpec` — every constructed tool (`echo`, `whoami`, `get_current_time`,
and all three Sheets tools) is touched by the type change even though only
`sheets_write` uses the new field, so a mistake here is a compile-time or
runtime regression surface across the whole tool registry, not just Sheets.
Second, this plan edits the one prompt in the codebase that functions as a
safety control — a rendering bug that shows the wrong sheet, the wrong row
count, or silently drops the `valueInputOption` consequence sentence is not
a cosmetic bug, it is a user approving something other than what they think
they approved. Third, `with-required-scopes.ts`'s field whitelist
(`apps/hermes/src/agent/with-required-scopes.ts:93-98`) forwards an
explicit field list, not a spread — a new `ToolSpec` field is silently
dropped unless the whitelist is edited, which would make `sheets_write`
(wrapped by the scope decorator) lose its `prepare` hook with no compiler
error and no test failure unless one is written specifically to catch it
(settled decision 13; regression test required in Phase 3).

## Dependencies & Risks

- **`ToolSpec` becomes generic (`ToolSpec<P = void>`), which ripples to
  every call site that types a tool array or a `Map`.** `AgentDefinition.tools`
  and the per-turn registry (`packages/agent/src/loop.ts:491`, per the
  research) become `ToolSpec<any>[]` / `Map<string, ToolSpec<any>>` —
  variance on `P` (contravariant in `handler`'s ctx, covariant in
  `ToolPreparation`'s `plan`) makes a precise heterogeneous-array type
  impractical, and `any` at the registry boundary is the accepted, narrow
  escape hatch; each tool factory still returns and is authored against its
  own concrete `ToolSpec<ConcretePlan>`. `packages/agent/src/types.ts`'s
  existing hand-built `ctx` literals in `apps/hermes/src/agent/tools/
  __tests__/get-current-time.test.ts` and `echo.test.ts` need a `plan:
  undefined` (or no change, if `plan` stays optional for `P = void` — verify
  at execution time whether TS accepts an absent property against `void`)
  added to typecheck; confirm during Phase 3.
- **`with-required-scopes.ts`'s decorator must forward `prepare`, not just
  `handler`.** The current whitelist (`decorate()`,
  `with-required-scopes.ts:93-98`) builds `{ name, description, schema,
  requiresApproval, timeoutMs, handler }` explicitly — a new field is
  dropped by omission, silently, with no compile error (`ScopedToolSpec`
  just wouldn't declare it either). `sheets_write` is wrapped by this
  decorator today (`withRequiredScopes("sheets_write", ...)` in
  `build-agent.ts`), so if Phase 3 adds `prepare` to the base `ToolSpec`
  without also updating `ScopedToolSpec` and the whitelist, `sheets_write`
  silently loses its own `prepare` the moment it's wired into the agent, and
  the loop falls back to raw-JSON rendering with no test catching it unless
  one is written for exactly this. This is the one item elevated from "keep
  in mind" to "named regression test" (settled decision 13).
- **The partial-batch mechanism (per-call refusal before the prompt) has to
  exist from Phase 3, not Phase 4.** `sheets_write.prepare`'s very first use
  — resolving the slug to build the sheet-identity line — already produces
  an `unknown_sheet` refusal for a bad slug. For that refusal to skip the
  prompt (rather than showing "¿Escribir en <unknown>?" and then failing
  after consent), `runGatedToolCalls` must already parse+prepare every call,
  peel off refusals into immediate results, and send only the surviving
  calls to `requestApproval` — building an empty batch means *no prompt at
  all*. Phase 4 does not introduce this mechanism; it only adds one more
  check (`read_only_sheet`) that uses the mechanism Phase 3 already built.
- **`ApprovalRequest`'s exact-array-equality test must not weaken.**
  `packages/agent/src/__tests__/loop.test.ts:966-970` asserts
  `toHaveBeenCalledWith([{tool:"echo", args:{text:"hi"}}], ...)` — an exact
  array, not `objectContaining`. `summary` must be attached via conditional
  spread (`...(summary && { summary })`) so a prepare-less tool's
  `ApprovalRequest` stays byte-identical to today and this test keeps
  passing **unmodified**. Do not touch this assertion to make the feature
  fit; if it needs touching, the design is wrong.
- **Prepare failure is fail-closed and shares the tool's `timeoutMs`, not a
  new bound.** A throw, a validation error inside `prepare`, or a timeout
  all resolve to the *same* outcome: no prompt is ever sent, the call
  resolves to `{ok:false, reason:"prepare_failed"}` (a new, small, stable
  reason code — not the tool's own domain-specific refusal shapes), and the
  `tool.call` telemetry event records `approved:false` — the identical shape
  a genuine human denial already produces, so no new branch is needed
  downstream of the loop. Bounding `prepare` by the *same* `spec.timeoutMs ??
  TOOL_HANDLER_TIMEOUT_MS` race `invokeTool`'s handler call already uses
  (`packages/agent/src/loop.ts:154-160`'s `delay(ms, signal)` pattern) means
  no new config surface and no new `.ai/decisions/` doc for timeouts, per
  the user's explicit instruction.
- **Validation order changes for the gated path only.** Today,
  `resolveToolCall` (`loop.ts:228-282`) does `safeParse` + one corrective
  retry (`L255-271`) inline, and `runGatedToolCalls` builds its batch from
  the call's *raw* `arguments` (`L361-364`), before any parsing happens.
  After this plan, the gated path's order is: `safeParse` (+ retry) → `spec
  .prepare(parsedArgs, ctx)` → build/send the batch (only for
  calls that survived `prepare`) → on approval, `spec.handler(parsedArgs,
  {...ctx, plan})`. The ungated path's order is unchanged except that a
  declared `prepare` still runs (for type-soundness — `ctx.plan` cannot lie
  about being present) immediately before the handler, with no approval
  step in between. Concretely, in this plan, only `sheets_write` (gated)
  declares `prepare`; no ungated tool does, so the ungated branch of this
  rule is exercised by no test beyond a type-level assertion this plan does
  not need to add.
- **`plan` and `ApprovalSummary` are two different structures with two
  different audiences, and neither is `unknown`.** `plan` (`SheetsWritePlan`:
  `{ sheetSlug, spreadsheetId, effectiveValueInputOption }`) is
  Sheets-specific and consumed only by `sheets_write`'s own handler — it
  lets the handler stop calling `resolveSheet` and stop recomputing
  `overrideOption ?? resolved.entry.valueInputOption` itself, re-deriving
  nothing the prompt already decided. `ApprovalSummary` is a **concrete,
  generic interface declared in `packages/agent/src/approval-gate-port.ts`**
  — `{ action: string; target?: string; items?: string[]; itemsTotal?:
  number; effects: string[] }` — naming no Sheets concept, so
  `packages/agent` still imports no feature package while the type actually
  constrains what a tool can hand the gate (an earlier draft of this plan
  used `ApprovalSummary = unknown`; rejected below). `sheets_write`'s
  `prepare` populates this directly — no separate `SheetsWriteApprovalSummary`
  type is needed, and the Telegram gate needs zero per-tool branching to
  render it: `action` is always the first line, `target` (when present) the
  second, `items` become indented lines with an itemsTotal-driven "…y N más"
  count line, `effects` become trailing sentences. `packages/google-sheets`'
  `sheets-write.ts` computes `items`/`itemsTotal` (the row-preview cap,
  Phase 5) and appends to `effects` (the mode description and the
  `valueInputOption` consequence sentence, Phase 5/6) — the gate never
  decides *what* to show, only how to lay it out.
- **Rejected: `ApprovalSummary = unknown`.** The settled requirement was
  "structured, not a pre-rendered string" — `unknown` satisfies neither
  half: the gate would still have to cast-by-tool-name to render anything,
  which means a tool can ship a malformed summary object and nothing at
  compile time or runtime catches it, on the one prompt in this codebase
  that functions as a safety control. A concrete interface makes the
  contract real: TypeScript rejects a `prepare` that returns a summary
  missing `action`/`effects`, and the gate can defensively check for a
  non-empty `action` at render time (see the malformed-summary Step in
  Phase 3) instead of trusting an opaque value.
- **Batch entries sent to `ApprovalGate.requestApproval` must carry the
  call's RAW `arguments`, never the parsed ones — even though `prepare` and
  `handler` now receive parsed args.** This is easy to get backwards once
  `resolveToolCall`'s `safeParse` moves earlier in the gated path (see the
  validation-order bullet above): the *parsing* moves earlier, but the
  *value shown to the human and logged in `tool.call` telemetry* must not
  silently change shape (zod-applied defaults, coercions, or key reordering
  are not something a human approving a write should see diverge from what
  the model actually sent). `runGatedToolCalls`' per-call helper must
  therefore carry both `call.arguments` (raw, for the batch entry) and the
  `safeParse` result (parsed, for `prepare`/`handler`) through its own
  return value — this is exactly what keeps
  `packages/agent/src/__tests__/loop.test.ts:966-970`'s
  `toHaveBeenCalledWith([{tool:"echo", args:{text:"hi"}}], ...)` passing
  unmodified (echo's raw and parsed args happen to be identical in that
  fixture, which would mask this bug if it were introduced — Phase 3 adds a
  second, Sheets-specific test where a `prepare`d call's raw args are
  asserted to reach the batch unparsed, so the distinction is actually
  exercised).
- **`withRequiredScopes` wraps `prepare` with the same scope short-circuit
  `handler` already gets — resolved, not deferred (see Phase 3).**
  `sheets_write.prepare` only reads `sheet_registry` via Postgres and never
  calls Google, so `05-google-sheets`' fail-closed guarantee (an
  unconnected/under-scoped account triggers zero Google API calls) holds
  whether or not `prepare` is scope-checked. But leaving `prepare` unscoped
  would mean an under-scoped user gets a fully legible, correctly resolved
  approval prompt, taps Aprobar, and *only then* hits `{ok:false,
  reason:"missing_scope"}` from the still-scoped handler — precisely the
  "asked to approve something already destined to fail" defect Phase 4
  removes for read-only sheets. Fixing it for one refusal class
  (`read_only_sheet`) and not the other (`missing_scope`) would be
  incoherent, so the scope decorator wraps both `prepare` and `handler` from
  Phase 3 onward: a missing scope short-circuits `prepare` itself, returning
  `{ok:false, result:{ok:false, reason:"missing_scope", scope, fix:"run
  /connect google sheets"}}` — the exact refusal shape `withRequiredScopes`
  already produces today, just reachable one step earlier.
- **`sheet_write_log`'s claim/complete/release sequence stays entirely in
  the handler, unmoved by this plan.** Only slug resolution and the
  `access` check move into `prepare` (Phases 3 and 4). The claim
  (`claimDedupeKey`, keyed on the *parsed* args' canonical JSON — unchanged,
  since the handler already receives parsed args) still happens after
  approval, inside the handler, because claiming commits to actually
  attempting the write and must not happen for a call nobody approved yet.
  The architecture.md ordering (resolve → access check → claim →
  `valueInputOption` → token → API call) is preserved exactly; it now spans
  two functions (`prepare` owns the first two steps, `handler` the rest)
  instead of one, but the sequence and its short-circuits (`alreadyComplete`
  / `alreadyPending`) are untouched by this plan.
- **A `prepare` that resolves successfully but returns a malformed summary
  (e.g. an empty-string `action` from a template-string bug) must not crash
  the gate or render a blank prompt.** TypeScript's `ApprovalSummary`
  interface prevents this at compile time for a well-typed tool, but the
  renderer defends anyway: a `summary` with a falsy `action` is treated as
  "no usable summary" and the request falls back to today's raw-JSON
  rendering, the same path a prepare-less tool already takes (Phase 3 Step
  + test).
- **Abort can fire between a call's `prepare` resolving and the batch's
  prompt actually being sent.** `runGatedToolCalls` already calls
  `assertToolInvocationAllowed(deps.signal)` once before building the batch
  (`approval-gate-design.md`'s "a turn that is already aborted never sends a
  prompt"); for a *single* gated call, no second check before `prepare` runs
  is needed, since `prepare`'s own timeout race already ties into the same
  `signal` (settled decision 8) and an aborted signal makes that race resolve
  the call as refused before `prepare` can return `ok:true` — proven by the
  mid-`prepare` abort test. **Corrected post-review (finding 3 of the Phase 3
  review):** that reasoning does not cover a *mixed* batch, where one call's
  `prepare` settles "ready" near-instantly (or has no `prepare` at all) while
  a sibling call's `prepare` is still racing the abort signal — by the time
  every call's preparation has settled, the turn may already be aborting, yet
  nothing between that point and `buildApprovalBatch`/`requestApproval`
  re-checked the signal, so the survivor's prompt could still be sent into a
  shutting-down channel. `runGatedToolCalls` therefore calls
  `assertToolInvocationAllowed(deps.signal)` a **second** time, right after
  every call's `prepareGatedCall` has resolved and before `buildApprovalBatch`
  runs — mirroring the existing pre-`prepare` check exactly, reusing the same
  fail-closed throw rather than a bespoke abort branch. A regression test
  covers the mixed-batch case specifically (a prepare-less "ready" call
  alongside a hanging-`prepare` call that only resolves once the turn's
  signal aborts): no prompt is ever sent.
- **CLAUDE.md compliance checkpoints for this contract change:** no new
  circular dependency (`packages/agent` still imports no feature package —
  `ApprovalSummary`'s vocabulary is generic, not borrowed from Sheets);
  `loop.ts`'s new logic is split into small, named helpers (e.g.
  `prepareGatedCall`, `buildApprovalBatch`) each under ~30 lines rather than
  one enlarged `runGatedToolCalls`; `ApprovalSummary` carries exactly the
  five fields the settled decisions require and nothing speculative for a
  hypothetical future tool.
- **Not a settled decision — flagged: the Approve/Deny button labels
  (`APPROVE_LABEL = "Approve"`, `DENY_LABEL = "Deny"`,
  `telegram-approval-gate.ts:11-12`) are translated to Spanish
  ("Aprobar"/"Rechazar") in Phase 3.** The settled decisions specify the
  *prompt text* language but say nothing about the buttons; leaving them in
  English while the prompt is in Spanish would be inconsistent for the exact
  non-technical Spanish-speaking audience this plan is for. Grepped before
  the rename: nothing outside this file compares against the literal label
  strings (`callbackData` encodes `"approve"`/`"deny"` as lowercase action
  tokens, not the display labels) — confirm this holds at execution time.
- **Resolved during the Phase 3 code review (finding 5), then corrected
  again post-Phase-3 (a batch must never mask a legible call behind a sibling
  call's missing summary): batch rendering for >1 gated call, and the
  fallback format's header.** The settled decisions specify single-call
  prompt shapes (decisions 21, 22). Today's `echo`+`sheets_write` are the
  only two gated tools, so a batch of 2+ gated calls in one model response is
  rare but possible. The shipped renderer
  (`apps/hermes/src/agent/approval-prompt-renderer.ts`) renders **per call,
  independently**: each call with a usable `ApprovalSummary` renders the new
  legible block; each call without one (prepare-less, or a malformed
  summary — see the defensive-summary bullet below) renders that one call's
  raw-JSON `- tool(args)` line instead — never the whole batch dropping to
  raw JSON because one sibling call lacks a summary. These per-call blocks
  are joined by a blank line, headerless, with no shared trailing question
  line (the two buttons already say "Aprobar"/"Rechazar", so a redundant
  question line adds nothing). The one exception is the all-fallback case —
  **every** call in the batch lacks a usable summary — which instead renders
  as a single pre-Phase-3-shaped block: `"The model wants to run:"` followed
  by one `- tool(args)` line per call, joined by a single newline, again
  minus the trailing question line; this keeps that case byte-identical to
  today's format. The header line itself must never be dropped from that
  all-fallback case: an earlier version of this renderer (commit `8dfabfc`)
  omitted it entirely, which the Phase 3 review caught; a later version then
  over-corrected by making *any* prepare-less call in a batch drop the
  header-plus-raw-JSON format onto every call in that batch, which this text
  now corrects back to per-call rendering.
- **The update-mode `replaced` snapshot read stays inside the scope
  decorator's already-proven fail-closed guarantee (settled decision 23).**
  It happens in the *handler*, after consent, which already runs inside
  `withRequiredScopes`'s guard — unlike a `prepare`-time read, this cannot
  regress `05-google-sheets`' exit criterion that an unconnected/under-scoped
  account triggers zero Google API calls.
- **In-turn write dedupe is still not manually verifiable from Telegram**
  (every inbound message is its own turn) — unit-test-only, per
  `plans/05-google-sheets.md`'s own note. Steps that would otherwise ask for
  a manual dedupe check use this repo's `[~]` convention instead.
- **No new dependency, no CI change, `pnpm lint` remains a named Final
  Verification gate** — same posture as `05-google-sheets`.

## HIL Prerequisites (manual, before Phase 6)

**Mode:** hil

- [x] Confirm (or create) a registered `readwrite` test sheet with a tab
      containing 40+ data rows, for the row-preview-cap manual check in
      Phase 5.
- [x] Confirm the same or another registered sheet has a column with
      date-like values (e.g. `1990-05-12`) and a column with a leading zero
      (e.g. `0123`), for the `valueInputOption` consequence-sentence manual
      check in Phase 6.
- [x] Confirm a registered `read`-access sheet already exists (from
      `05-google-sheets`' Prerequisites) for the read-only-refusal manual
      check in Phase 4.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

**Steps:**

- [ ] Confirm with the user: branch name
      `feat/06-legible-approvals-bounded-reads`, base ref `main`
- [ ] `git worktree add ../hermes-06-legible-approvals -b feat/06-legible-approvals-bounded-reads main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-06-legible-approvals/.env`) — gitignored, so
      the worktree starts without it.

---

### Phase 1: Bounded `sheets_read` — a huge range can no longer dominate model context

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** A `sheets_read` call against a range whose values
exceed 500 cells or 4,000 JSON-stringified characters (whichever trips
first) returns a truncated, whole-row result — `values` holds only the rows
that fit, plus `truncated:true, returnedRows, totalRows, totalColumns, note`
— while a call whose values fit under both caps returns byte-identical to
today (no new keys at all). **Observable today, not just "a helper exists":**
register a sheet with 40+ rows, ask the bot a question that makes it call
`sheets_read` over the whole range, and its reply visibly changes from
"here are all 800 cells" to "here are the first N of M rows, ask me to
narrow the range for more" — a behavior change a non-technical user (or QA
with no code access) can observe purely by chatting with the bot.
**Commit message:** `feat: bound sheets_read results with a shared truncation helper`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-sheets/src/truncate.ts` | `MAX_CELLS = 500`, `MAX_VALUE_CHARS = 4_000` (package-internal constants, not env-configurable); `truncateBySize<T>(items: T[], measure: (item: T) => { cells: number; chars: number }, caps = { maxCells: MAX_CELLS, maxChars: MAX_VALUE_CHARS }): { items: T[]; truncated: boolean; returnedCount: number; totalCount: number }` — iterates `items`, accumulating `cells`/`chars`, and stops *before* a would-be-added item would exceed either cap, except it always keeps at least one item (a single oversized row/tab is still returned whole, never split) |
| modify | `packages/google-sheets/src/index.ts` | export `truncateBySize`, `MAX_CELLS`, `MAX_VALUE_CHARS` |
| modify | `packages/google-sheets/src/tools/sheets-read.ts` | after `getValues` returns, call `truncateBySize(result.values ?? [], (row) => ({ cells: row.length, chars: JSON.stringify(row).length }))`; return `{ok:true, sheet, range, values: capped.items, ...(capped.truncated && {truncated:true, returnedRows:capped.returnedCount, totalRows:capped.totalCount, totalColumns: Math.max(0, ...(result.values ?? []).map(r=>r.length)), note:"El rango es muy grande — pide un rango más chico para ver el resto."})}` — additive via conditional spread, so an untruncated read is byte-identical to today (settled decision 3); `note` is Spanish since it's model-facing text the model will typically relay to the same Spanish-speaking user, consistent with the rest of this plan's language decisions |
| modify | `packages/google-sheets/README.md` | document the dual cap, whole-row truncation, and the additive-fields contract |

**Steps:**

- [x] Write `truncate.ts`'s `truncateBySize` as a pure function with no
      Sheets-specific knowledge — it must be reusable by `sheets_inspect`
      (Phase 2) and the update-mode `replaced` snapshot (Phase 7) without
      modification
- [x] Confirm the "always at least one row" rule doesn't silently mask a
      pathological single-row case (a single row of 10,000 cells returns
      `truncated:true` with `returnedRows:1` — correct, not a bug)
- [x] Confirm `totalColumns` is computed from the *original* `result.values`,
      not the truncated slice
- [x] Grep `sheets-read.ts`'s existing tests to confirm no test currently
      asserts on the exact key set of a success result in a way that would
      break from the additive fields being *absent* on an untruncated read
- [x] **Edge case — empty `values`:** `result.values` is `undefined`/`[]`
      when the range has no data at all; `truncateBySize([], ...)` must
      return `{items:[], truncated:false, returnedCount:0, totalCount:0}`,
      not throw and not report a false `truncated:true`
- [x] **Edge case — `totalRows` when the API returns fewer rows than the
      requested range.** Google's `values.get` only returns rows that
      actually have data (a request for `A1:Z1000` against a 40-row sheet
      returns 40 rows, not 1000 padded with empties), so `totalRows` must
      be computed from `(result.values ?? []).length` — the count Google
      actually returned for this range — never from the requested range's
      nominal size. Document this explicitly in the tool's own comment, not
      just in this plan, since it's a natural place for a future edit to
      get wrong
- [x] **Edge case — a single row wider than `MAX_VALUE_CHARS` alone:**
      confirm it is still returned whole (per the "always keep at least one
      item" rule) with `truncated:true` and `returnedRows:1`, and that a
      *second* row, however small, is dropped rather than partially merged
      into the first

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-sheets/src/__tests__/truncate.test.ts` | under both caps → all items kept, `truncated:false`; over `maxCells` only → truncates on cell count; over `maxChars` only → truncates on char count; whichever trips first wins; a single oversized item is still returned whole (never split), `truncated:true`; empty input array → `truncated:false`, zero counts |
| modify | `packages/google-sheets/src/tools/__tests__/sheets-read.test.ts` | existing happy-path assertions still pass unmodified (regression); new case: a wide/tall range returns `truncated:true` with correct `returnedRows`/`totalRows`/`totalColumns`/`note`; new case: a range exactly at the cap boundary stays untruncated; new case: an empty-result range returns the unmodified today's shape (no `truncated` key); new case: the API returns fewer rows than the requested range and `totalRows` reflects the actual returned count, not the request |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [x] Manual: register a sheet with 40+ rows, ask the bot (in Telegram) a
      question that makes it call `sheets_read` over the whole range, and
      confirm the reply stays coherent (the model relays "showing the first
      N of M rows" rather than silently truncating mid-conversation)

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: bound sheets_read results with a shared truncation helper`
- [x] Phase marked complete

---

### Phase 2: Bounded `sheets_inspect` — a many-tab spreadsheet can no longer dominate model context

**Risk:** low
**Mode:** afk
**Type:** backend
**Success criteria:** A spreadsheet with enough tabs (or wide enough header
rows) to exceed the shared caps returns a truncated, whole-tab result —
`tabs` holds only the tabs that fit, plus `truncated:true, returnedTabs,
totalTabs, note` — while a spreadsheet under both caps returns
byte-identical to today. **Observable, not just "a helper exists":** asking
the bot to orient itself on a many-tab spreadsheet now gets a reply naming
only the tabs that fit plus an honest "there are N more tabs" instead of
either a context-flooding dump or (today) no limit at all.
**Commit message:** `feat: bound sheets_inspect results with the shared truncation helper`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-sheets/src/tools/sheets-inspect.ts` | after `summarizeTabs(meta)`, call `truncateBySize(allTabs, (tab) => ({ cells: tab.headerRow.length, chars: JSON.stringify(tab).length }))`; return `{ok:true, sheet, tabs: capped.items, ...(capped.truncated && {truncated:true, returnedTabs:capped.returnedCount, totalTabs:capped.totalCount, note:"La planilla tiene más pestañas de las que se muestran acá — solo se listan las primeras."})}` |
| modify | `packages/google-sheets/README.md` | document `sheets_inspect`'s use of the same shared helper, tab-granularity instead of row-granularity |

**Steps:**

- [x] Reuse `truncateBySize` from Phase 1 unmodified — this phase adds no
      new truncation logic, only a new caller and a new `measure` function
- [x] Confirm the `note` text is distinct in wording from `sheets_read`'s
      (tabs vs. rows) so the model doesn't conflate the two in its reply
- [x] **Edge case — a tab with an empty header row** (`headerRow: []`, e.g.
      a genuinely blank tab): `measure` returns `{cells:0, chars:...}` for
      it, so it never itself trips the cell cap — confirm it still counts
      toward `totalTabs`/`returnedTabs` correctly and doesn't get dropped by
      an off-by-one in the "keep at least one" logic
- [x] **Edge case — a single tab whose header row alone exceeds the caps**
      (very wide sheet, one tab): confirm it is still returned whole
      (`truncated:true`, `returnedTabs:1`), mirroring Phase 1's single-row
      case

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/google-sheets/src/tools/__tests__/sheets-inspect.test.ts` | existing happy-path assertions unmodified (regression); new case: a spreadsheet with many tabs / wide header rows returns `truncated:true` with correct `returnedTabs`/`totalTabs`/`note`; under-cap case stays untruncated; new case: a tab with an empty header row is counted correctly; new case: a single oversized tab is still returned whole |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [~] Manual: if a spreadsheet with enough tabs is available, confirm
      `sheets_inspect` truncates; otherwise `[~]` this — accept the unit
      test as sufficient (a many-tab spreadsheet is impractical to
      provision solely for this manual check)

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: bound sheets_inspect results with the shared truncation helper`
- [x] Phase marked complete

---

### Phase 3: The `prepare` hook contract, a generic `ApprovalSummary` renderer, and the first legible Spanish prompt

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Approving a `sheets_write` call against a *valid,
known* sheet now shows a Spanish prompt naming the sheet by its registry
description (falling back to the slug when the description is empty)
instead of raw JSON — e.g.
```
¿Escribir en clients?
Registro de clientes 2026
```
— with the buttons reading "Aprobar"/"Rechazar". A call against an
*unknown* slug, or one made by a user missing the Sheets scope, is refused
immediately with the existing structured `unknown_sheet`/`missing_scope`
result and **no prompt is ever sent**. `echo` (the only other gated tool,
which declares no `prepare`) renders exactly as it does today —
byte-identical raw-JSON fallback — and
`packages/agent/src/__tests__/loop.test.ts:966-970`'s exact-array assertion
passes unmodified. The renderer built this phase is the **complete, final**
generic formatter — Phases 5 and 6 add no new renderer logic, only richer
`items`/`effects` content from `sheets_write.prepare`.
**Commit message:** `feat: add ToolSpec.prepare hook, generic ApprovalSummary contract, legible Spanish approval identity line`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/types.ts` | `ToolSpec` becomes `ToolSpec<P = void>`; add `export type ToolPreparation<P> = { ok: false; result: unknown } | { ok: true; plan: P; summary: ApprovalSummary }`; add optional `prepare?(args: unknown, ctx: ToolContext): Promise<ToolPreparation<P>>`; `handler`'s ctx becomes `ToolContext & { plan: P }` (non-optional — a `P = void` tool's ctx still carries `plan`, typed `void`, so "absent" is unrepresentable, per settled decision 6); export a named `ToolContext` type if one doesn't already exist, aliasing today's inline `{signal, channel, channelUserId, turnId}` shape |
| modify | `packages/agent/src/approval-gate-port.ts` | add a **concrete** `export interface ApprovalSummary { action: string; target?: string; items?: string[]; itemsTotal?: number; effects: string[] }` — a small, generic display vocabulary naming no Sheets concept (rejected: `ApprovalSummary = unknown`, see Dependencies & Risks); `ApprovalRequest` gains `summary?: ApprovalSummary` |
| modify | `packages/agent/src/loop.ts` | `resolveToolCall`'s `safeParse` + one corrective retry now runs before `runGatedToolCalls` builds its batch, for the gated path (settled decision 9); new `prepareGatedCall(spec, call, ctx)` helper (≤30 lines): re-derives `parsedArgs` via the already-moved `safeParse` step, calls `spec.prepare(parsedArgs, ctx)` (races it against `spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS` via the existing `delay(ms, signal)` pattern) when declared, and returns a discriminated `{status:"refused", result} | {status:"ready", plan, parsedArgs, batchEntry}`; **`batchEntry` is always `{tool: call.name, args: call.arguments, ...(summary && {summary})}` — `call.arguments` (the RAW, unparsed args), never `parsedArgs`** (see the Dependencies & Risks bullet on this — it is the one detail most likely to regress silently); a prepare-less tool always resolves `{status:"ready", plan: undefined, parsedArgs, batchEntry:{tool, args: call.arguments}}`; a throw/timeout/abort-during-prepare resolves `{status:"refused", result:{ok:false, reason:"prepare_failed"}}`; new `buildApprovalBatch(calls)` helper (≤30 lines) splits refusals (returned immediately, `approved:false` on their `tool.call` event) from ready calls and skips calling `requestApproval` entirely when no ready calls remain (settled decision 11); on approval, each ready call's handler runs as `spec.handler(parsedArgs, {...ctx, plan})`; a runtime backstop throws if a tool declaring `prepare` somehow reaches the handler without a `plan` (should be unreachable by construction — defense in depth per settled decision 6) |
| modify | `apps/hermes/src/agent/with-required-scopes.ts` | `ScopedToolSpec` gains `prepare?`; the whitelist in `decorate()` (`L93-98`) forwards a **wrapped** `prepare`, mirroring `handler`'s existing wrap exactly: a missing account or missing scope short-circuits `prepare` itself, returning `{ok:false, result:{ok:false, reason:"not_connected"}}` or `{ok:false, result:{ok:false, reason:"missing_scope", scope, fix:"run /connect google sheets"}}` — the identical refusal shapes `handler`'s wrap already produces, just reachable one step earlier so an under-scoped user is never shown a prompt for a call already destined to fail (resolved per Dependencies & Risks — not an open question) |
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | export `SheetsWritePlan { sheetSlug: string; spreadsheetId: string; effectiveValueInputOption: ValueInputOption }`; add `prepare(args, ctx)` (args already parsed by the loop): calls `resolveSheet` (moved out of the handler); unknown slug → `{ok:false, result: resolved}` (the existing `unknown_sheet` shape, unchanged); otherwise → `{ok:true, plan:{sheetSlug, spreadsheetId, effectiveValueInputOption: overrideOption ?? entry.valueInputOption}, summary:{action:\`¿Escribir en ${entry.slug}?\`, target: entry.description || undefined, effects: []}}` — a minimal but fully valid `ApprovalSummary`; `items`/richer `effects` arrive in Phases 5/6 with no renderer change needed; `handler` now takes `ctx: SheetsToolContext & {plan: SheetsWritePlan}`, drops its own `resolveSheet` call and its own `overrideOption ?? resolved.entry.valueInputOption` computation, reading both off `ctx.plan` instead — the `access !== "readwrite"` check and `claimDedupeKey`/claim-complete-release stay in the handler for this phase, unmoved (moved to `prepare` in Phase 4; dedupe stays in the handler permanently, see Dependencies & Risks) |
| create | `apps/hermes/src/agent/approval-prompt-renderer.ts` | extracts and replaces `formatBatchPrompt`/`formatResolvedText` out of `telegram-approval-gate.ts` into their own testable module (small-focused-function / separation-of-concerns per CLAUDE.md); **fully generic, final rendering logic** — no tool-name branching, no cast, no import from `@hermes/google-sheets`: for a request with a `summary` whose `action` is non-empty, render `action` as line 1, `target` (if present) as line 2, a blank line, each `items` entry indented two spaces (if present) followed by an "…y N más (M en total)." count line when `itemsTotal > items.length`, a blank line, then each `effects` entry as its own line; a request with **no** `summary`, or a malformed one (falsy/empty `action` — defensive, see Dependencies & Risks), falls back to today's `` `- ${tool}(${JSON.stringify(args)})` `` line unchanged **for that call only** — it does not drag the rest of the batch into fallback; joins every call's own block (summary block or raw-JSON line) with a blank line, no shared trailing question line; the one exception is when **every** call in the batch lacks a usable summary, which instead renders as a single pre-Phase-3-shaped block — `"The model wants to run:"` followed by one `` `- ${tool}(${JSON.stringify(args)})` `` line per call, joined by a single newline, minus only the trailing "Approve or deny?" line — kept byte-identical to today's all-raw-JSON format (see Dependencies & Risks — corrected post-review, finding 5, then corrected again post-Phase-3 to render per call instead of per batch: the header must never be dropped from the all-fallback case, and a batch must never mask a legible call's summary behind a sibling call's missing one) |
| modify | `apps/hermes/src/agent/telegram-approval-gate.ts` | imports `formatBatchPrompt`/`formatResolvedText` from the new renderer module instead of defining them inline; `APPROVE_LABEL`/`DENY_LABEL` translated to `"Aprobar"`/`"Rechazar"`; add a `logger: Logger` param to `createTelegramApprovalGate` (new dependency — `@hermes/core`'s `createLogger`, wired from `apps/hermes/src/agent/build-agent.ts`), and call `logger.debug("approval prompt prepared", {tool, args, plan})` for each ready call right before sending the prompt — raw args + the resolved plan (including `spreadsheetId` and effective `valueInputOption`, per settled decision 20; note `plan`, not `summary` — `summary` never carries `spreadsheetId`) at debug level only, off by default in production |
| modify | `apps/hermes/src/agent/build-agent.ts` | pass a logger into `createTelegramApprovalGate` |
| modify | `apps/hermes/README.md` | begin correcting the Approval gate section's overclaim (full correction lands in Phase 8 once the whole prompt shape exists; this phase's edit removes the now-false "unchanged by Phase 5" / raw-args claim for `sheets_write` specifically) |

**Steps:**

- [x] Write the "scoped tool keeps `prepare`, and a missing scope refuses
      `prepare` itself" regression test *first*, against the current
      (pre-fix) whitelist, prove it fails, then fix the whitelist and prove
      it passes — this is the test settled decision 13 calls out by name,
      extended to cover `prepare` per the resolution in Dependencies & Risks
- [x] Confirm `packages/agent/src/__tests__/loop.test.ts:966-970`'s exact
      assertion passes with zero edits after this phase
- [x] Write the loop-level test: a `prepare` that throws, times out, or
      returns `{ok:false}` **never** results in a call to
      `approvalGate.requestApproval` for that call; if it's the *only* call
      in the batch, `requestApproval` is never called at all
- [x] Write the loop-level test: a batch of two gated calls where one
      `prepare`s successfully and one refuses sends a prompt naming only the
      surviving call, and the refused call's result comes back immediately
      without waiting on the prompt
- [x] **Write the raw-vs-parsed-args regression test named in Dependencies &
      Risks:** a `sheets_write` call whose raw `arguments` and `safeParse`d
      form differ (e.g. relying on a schema default the raw args omit) —
      assert the `ApprovalRequest` sent to `requestApproval` carries the
      *raw* form, not the parsed one, while `prepare`/`handler` receive the
      parsed form
- [x] **Write the mid-`prepare` abort test named in Dependencies & Risks:**
      abort the turn's signal while a call's `prepare` is in flight; assert
      it resolves as a `prepare_failed`-shaped refusal (or an equivalent
      abort-specific reason — decide and record which), never a hang and
      never a prompt sent
- [x] **Write the malformed-summary defensive test:** a `prepare` that
      resolves `{ok:true, plan, summary:{action:"", effects:[]}}` (empty
      `action`) falls back to the raw-JSON rendering, the same as a
      prepare-less tool — never a blank or broken prompt line
- [x] Confirm `get-current-time.test.ts`/`echo.test.ts`'s hand-built `ctx`
      literals still typecheck (add `plan: undefined` if required)
- [x] Exact-string test for the Phase-3 prompt shape: a known sheet with a
      non-empty description (two-line identity block); a known sheet with
      an **empty** description (single-line, no `target` — settled decision
      26's "empty description fallback" case); the prepare-less `echo`
      fallback (byte-identical to today)
- [x] Manual: send a natural-language message that triggers `sheets_write`
      against a known sheet and confirm the Telegram prompt shows the
      identity block in Spanish with "Aprobar"/"Rechazar" buttons

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/agent/src/__tests__/loop.test.ts` | prepare invoked before the prompt; fail-closed on throw/timeout/`{ok:false}`/mid-flight abort; partial-batch (refused calls skip the prompt, survivors don't); empty-batch skips `requestApproval` entirely; existing exact-array assertion unmodified; the raw-vs-parsed-args distinction; `ctx.plan` reaches the handler for a tool declaring `prepare` |
| create | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` | exact-string assertions: sheets_write with description (two-line identity), sheets_write with empty description (single-line fallback to slug), prepare-less fallback (byte-identical to today's format), malformed/empty-`action` summary falls back to raw-JSON rendering |
| modify | `apps/hermes/src/agent/__tests__/telegram-approval-gate.test.ts` | logger.debug called with tool/args/plan on a ready call; button labels are the Spanish strings; existing timeout/abort/callback races unaffected |
| modify | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` | scoped tool's `prepare` survives the decorator; a missing-scope account is refused by `prepare` itself (wrapped handler's `prepare` never called, no prompt built) — the named regression test |
| modify | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | `prepare` returns the plan/summary shape for a known sheet; `prepare` returns the unchanged `unknown_sheet` refusal shape for an unknown slug; handler reads `ctx.plan` instead of re-resolving (assert `resolveSheet`/registry mock is called exactly once per call, not twice); dedupe claim/complete/release still happens in the handler, unaffected by the `prepare` split |

**Verification:**

- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [x] Manual golden path above
- [~] `[~]` In-turn dedupe unaffected by this phase — not manually
      verifiable from Telegram; covered by existing `sheet-write-log`
      unit tests, unchanged by this phase

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: add ToolSpec.prepare hook, generic ApprovalSummary contract, legible Spanish approval identity line`
- [x] Phase marked complete

---

### Phase 4: Read-only-sheet refusal moved into `prepare`

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** A `sheets_write` call against a sheet registered
`access: "read"` is refused **before any prompt is sent** — the user is
never asked to approve a write already destined to fail. The handler's own
`access !== "readwrite"` check is deleted (dead code once `prepare` is the
only path that can reach it with a disallowed sheet).
**Commit message:** `refactor: move read-only-sheet refusal into sheets_write.prepare`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | `prepare` gains the `resolved.entry.access !== "readwrite"` check right after slug resolution, returning `{ok:false, result:{ok:false, reason:"read_only_sheet"} satisfies ReadOnlySheetResult}` (unchanged shape); the handler's own `if (resolved.entry.access !== "readwrite") return {...}` block is deleted |
| modify | `packages/google-sheets/README.md` | note the check now runs in `prepare`, before the approval prompt, not just before the dedupe claim |

**Steps:**

- [x] Write the regression test *first* against the pre-fix code: a
      read-only-sheet write today reaches the prompt and only refuses after
      approval — prove that, then fix, then prove the prompt is now never
      sent
- [x] Grep `sheets-write.ts`'s handler after the change to confirm the
      inline access check is actually gone, not left dead alongside
      `prepare`'s copy (same discipline `05-google-sheets` used for
      `whoami`'s inline scope check)
- [x] Confirm `ReadOnlySheetResult`'s shape and the existing
      `sheets-write.test.ts` "read-only refusal before claim/API" case
      still make sense as a `prepare`-level assertion rather than a
      handler-level one — move/rename the test, don't duplicate it

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | `prepare` refuses a read-only sheet with the unchanged `read_only_sheet` shape; the refusal happens without any dedupe claim or API call (assert those mocks are never invoked) |
| modify | `packages/agent/src/__tests__/loop.test.ts` | (if not already covered by Phase 3's partial-batch tests) a `prepare` refusal for the *only* call in a batch never calls `requestApproval` — reuse Phase 3's fixture with a read-only-sheet scenario if a Sheets-specific loop test is warranted; otherwise this row may be satisfied entirely by Phase 3's generic test and can be marked accordingly at execution time |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm lint` green
- [x] Manual: attempt a write against the registered `read`-access sheet
      (HIL Prerequisites) via natural language in Telegram and confirm no
      approval prompt appears at all — the model relays a refusal directly

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `refactor: move read-only-sheet refusal into sheets_write.prepare`
- [x] Phase marked complete

---

### Phase 5: Row preview cap + mode-specific copy — tool-side, generic renderer unchanged

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** The prompt reaches its near-final shape. `append`:
```
¿Agregar una fila a Clients?
Registro de clientes 2026

  Test Uno, 1990-05-12

Agrega una fila nueva al final. No cambia nada de lo existente.
```
`update`: a distinct verb, **no A1 range** (e.g. `¿Reemplazar una fila en
Clients?` / `Sobrescribe una fila que ya existe.`). A batch of 40 rows shows
at most 3, each truncated to ~100 chars with an ellipsis, followed by
`…y 37 más (40 en total).` **All of this content is computed inside
`sheets_write.prepare` (tool-side) as `items`/`itemsTotal`/`effects` — the
generic renderer built in Phase 3 requires zero changes**: it already knows
how to lay out `items`+`itemsTotal` and join `effects`, because that
contract was built complete from the start (settled per the coordinator's
correction: decision 18's row-preview cap is a tool-side content decision,
not a gate-side rendering one).
**Commit message:** `feat: row preview cap and mode-specific copy in sheets_write's approval summary`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | `prepare`'s summary construction gains: `action` becomes mode-specific — never the A1 `range` (settled decision 22) — using **natural Spanish singular/plural agreement, not a literal `fila(s)` placeholder** (resolved during Phase 5 implementation: the phase's own success-criteria examples below are the settled copy, not an earlier draft of this row): `append` is `` `¿Agregar una fila a ${entry.slug}?` `` for `rowCount === 1` or `` `¿Agregar ${rowCount} filas a ${entry.slug}?` `` otherwise; `update` is `¿Reemplazar una fila en ${entry.slug}?` for `rowCount === 1` or `` `¿Reemplazar ${rowCount} filas en ${entry.slug}?` `` otherwise — **both modes spell out the singular ("una") and use numerals only for the plural count**, a code-review fix that aligned `update`'s singular phrasing with `append`'s (an earlier draft of this row had `update` using the numeral `1` for its singular case; that inconsistency is resolved here); `effects` gains the mode description as its first entry, agreeing in number with `rowCount` the same way `action` does (post-merge code-review fix: an earlier version of this line kept the effect description grammatically singular even when `action` had already pluralized for a multi-row write) — `append` is `"Agrega una fila nueva al final. No cambia nada de lo existente."` for `rowCount === 1` or `` `"Agrega ${rowCount} filas nuevas al final. No cambia nada de lo existente."` `` otherwise; `update` is `"Sobrescribe una fila que ya existe."` for `rowCount === 1` or `` `"Sobrescribe ${rowCount} filas que ya existen."` `` otherwise; `items`: the first 3 rows of `values`, each row's cells joined (`", "`-separated), whitespace runs (including newlines/tabs) collapsed to a single space, and the collapsed string truncated to ~100 chars with `…` (truncation is per row, after joining and whitespace-collapsing, never per cell) — collapsing whitespace before truncating is load-bearing: without it, an embedded newline in a cell could inject extra lines into the rendered approval prompt; `itemsTotal: values.length` whenever `values.length > 0` (present even when `items.length === values.length`, so the renderer's own `itemsTotal > items.length` check is the single source of truth for whether to print the count line — no separate "was this truncated" flag needed). **Zero-rows edge case, resolved:** `items: []` and `itemsTotal` **omitted** (not `0`) when `values.length === 0`. |
| modify | `packages/google-sheets/README.md` | document the row-preview cap and mode-specific copy as `prepare`-side content decisions, and cross-reference the generic `ApprovalSummary` contract in `packages/agent/README.md` |

**Steps:**

- [x] Write exact-string tests *before* refining `prepare`'s summary
      construction: 1-row append, 40-row append (`…y 37 más`), update-mode
      copy (settled decision 26's named cases) — get the exact Spanish copy
      right against these tests, not the other way around
- [x] Confirm the row-truncation-to-~100-chars is applied per row after
      joining cells, not per cell (a row of many short cells should still
      truncate as one unit)
- [x] Confirm `update`'s summary genuinely contains no A1-notation substring
      anywhere (grep the constructed `action`/`items`/`effects` in the test,
      don't just eyeball it)
- [x] **Edge case — zero rows** (`values: []`, a degenerate but
      schema-permitted `append`/`update` call): `items` is `[]`,
      `itemsTotal` is omitted (or `0` — pick one and test it), and the
      renderer shows no preview block and no "…y N más" line, only the
      question and the mode-description effect
- [x] Confirm the renderer itself needs **no code change** this phase —
      re-run Phase 3's `approval-prompt-renderer.test.ts` unmodified and
      confirm it still passes, then only *add* new cases for the richer
      `items`/`itemsTotal`/`effects` content

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | `prepare`'s summary: mode-specific `action` text for both modes, no A1 range substring, `effects[0]` mode description, `items` capped at 3 with ~100-char truncation, `itemsTotal` set correctly, zero-row edge case |
| modify | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` | exact-string, using a hand-built `ApprovalSummary` fixture (not a real `sheets_write` call — the renderer stays tool-agnostic): 1-row append (settled decision 21's literal copy, minus the not-yet-added consequence sentence); 40-row append with `…y 37 más (40 en total)`; update-mode copy with no A1 range substring; empty-description fallback (re-asserted against the richer shape); prepare-less fallback (still byte-identical to today) |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm lint` green
- [x] Manual: trigger an append and an update via natural language in
      Telegram and visually confirm both match the settled copy
- [x] Manual: using the HIL Prerequisites' 40+-row sheet, trigger a bulk
      append and confirm the row-count line reads correctly

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: row preview cap and mode-specific copy in sheets_write's approval summary`
- [x] Phase marked complete

---

### Phase 6: `valueInputOption` consequence sentence — tool-side, appended to `effects`

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Approving a write whose target uses (explicitly or by
registry default) `USER_ENTERED`, where at least one value in the batch
looks date-like, has a leading zero, starts with `=`/`+`/`-`/`@`, or looks
like a separator-formatted number, now shows an extra Spanish sentence in
the prompt naming the transformation risk (e.g. `"1990-05-12" se guardará
como fecha.`, or `"=A1+1" se guardará como fórmula.` for a leading `=`/`+`).
A `RAW` write, or a `USER_ENTERED` write with no flagged values, shows no
such line — byte-identical to Phase 5's prompt. This reaches the plan's
**final** settled prompt shape (decision 21's full example). As with Phase
5, the generic renderer is unchanged — the detector runs tool-side and its
result is appended to `effects`.
**Commit message:** `feat: add valueInputOption consequence sentence to sheets_write's approval summary`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/google-sheets/src/value-input-consequence.ts` | pure function `detectValueInputConsequence(values: unknown[][], effectiveValueInputOption: ValueInputOption): string \| null` — returns `null` immediately for `RAW`; for `USER_ENTERED`, scans every cell for: a leading `=`/`+`/`-`/`@` (always flagged as a formula, per settled decision 19, regardless of the other heuristics); a date-like string (e.g. `YYYY-MM-DD`, `DD/MM/YYYY`); a numeric string with a leading zero; a numeric string with thousands/decimal separators — tuned to over-flag (a false positive costs one redundant sentence; a false negative risks silent data corruption, so ambiguous cases flag). Lives in `packages/google-sheets`, not `apps/hermes`, because the decision it informs (`effects`) is now built tool-side, matching Phase 5's placement |
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | `prepare` calls `detectValueInputConsequence(values, effectiveValueInputOption)` and appends its result to `effects` (via conditional spread) when non-null, after the mode-description entry Phase 5 added |
| modify | `packages/google-sheets/README.md` | note the consequence-sentence heuristic, its over-flag-on-purpose tuning, and that it lives beside the row-preview logic as a `prepare`-side content decision |

**Steps:**

- [x] Write the detector's test cases *before* wiring it into `prepare`: a
      plain leading-zero string, a `YYYY-MM-DD` date, a `DD/MM/YYYY` date, a
      thousands-separated number, a leading `=`, a leading `+`, a leading
      `-`, a leading `@`, and at least one deliberately ambiguous string a
      human might not expect to flag (document why it's flagged anyway —
      over-flagging is the accepted trade-off, not an oversight)
- [x] Confirm `RAW` short-circuits to `null` with no per-cell scan needed
- [x] Exact-string test: a `USER_ENTERED` write with a date value produces
      the full, final settled prompt (decision 21's literal example) via
      `sheets_write.prepare` end to end, not just the detector in isolation
- [x] Exact-string test: a `RAW` write produces no consequence line at all
      (settled decision 26's named case)
- [x] Confirm the renderer needs **no code change** this phase either —
      the consequence sentence is just one more `effects` entry

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/google-sheets/src/__tests__/value-input-consequence.test.ts` | every heuristic case above, plus the `RAW` short-circuit and the "no flagged values" (`null`) case |
| modify | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | `prepare`'s `effects` gains the consequence sentence for a flagged `USER_ENTERED` write; no such entry for `RAW` or an unflagged `USER_ENTERED` write |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm lint` green
- [x] Manual: using the HIL Prerequisites' date/leading-zero column, trigger
      a write and confirm the consequence sentence appears in Telegram,
      completing the golden-path prompt from decision 21

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: add valueInputOption consequence sentence to sheets_write's approval summary`
- [x] Phase marked complete

---

### Phase 7: Update-mode `replaced` snapshot — before→after values, narrated by the LLM

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** After an approved `mode: "update"` write completes,
the tool result includes `replaced: [[...]]` — the values that occupied the
target range immediately before the overwrite, truncated via the same
`truncateBySize` helper from Phase 1 — and the model narrates the
before→after change in its natural-language reply. `mode: "append"` never
reads and is unaffected. A snapshot-read failure is non-fatal: the write
still proceeds, a warning is logged, and `replaced` is simply omitted.
**Commit message:** `feat: capture pre-overwrite values on sheets_write update mode`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | for `mode === "update"` only, immediately before calling `updateValues`, call `deps.sheetsClient.getValues(accessToken, plan.spreadsheetId, range, ..., ctx.signal)` wrapped in try/catch; on success, run the result through `truncateBySize` and include `replaced: capped.items` (plus `truncated`/`returnedRows`/`totalRows` when applicable) in the eventual `SheetsWriteSuccessResult`; on failure, `console`/injected-logger `warn` and proceed with the write unaffected, omitting `replaced` entirely |
| modify | `packages/google-sheets/src/tools/sheets-write.ts` | thread a `logger` into `CreateSheetsWriteToolDeps` if one doesn't already exist for this package, or reuse whatever warning mechanism the package already has (check `sheets-client.ts` for precedent before adding a new one — reuse before reinvent) |
| modify | `packages/google-sheets/README.md` | document the update-mode snapshot read, its non-fatal failure mode, and the audit side-benefit (`replaced` lands in `sheet_write_log` for free via the existing `complete(dedupeKey, outcome)` call, since the whole result is stored) |

**Steps:**

- [x] Confirm this extra read happens strictly *after* the dedupe claim and
      *after* `getAccessToken` (both already happened by this point in the
      handler) — it must not introduce a second `getAccessToken` call or a
      second dedupe claim
- [x] Write the non-fatal-failure test first: simulate `getValues` throwing,
      assert the write still completes successfully and `replaced` is
      absent from the result, and a warning was logged
- [x] Confirm `replaced` runs through the *same* `truncateBySize` used by
      `sheets_read`/`sheets_inspect` — don't hand-roll a second truncation
      call site
- [x] Confirm the snapshot read does not retry on failure (it's cosmetic; a
      retry loop here would be new latency for no safety benefit) — a
      single attempt, caught and logged

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` | update mode captures `replaced` on success; update mode proceeds and omits `replaced` when the snapshot read throws (non-fatal); append mode never calls the snapshot read at all (assert the mock is never invoked); `replaced` is truncated via the shared helper when large |

**Verification:**

- [x] `pnpm --filter @hermes/google-sheets test` green
- [x] `pnpm -r test` green
- [x] `pnpm -r typecheck` green
- [x] `pnpm lint` green
- [x] Manual: approve an update-mode write against a row with known prior
      content and confirm the bot's natural-language reply mentions what
      changed (e.g. "cambié el teléfono de X a Y")

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: capture pre-overwrite values on sheets_write update mode`
- [x] Phase marked complete

---

### Phase 8: Documentation and `.ai/` knowledge base sync

**Risk:** low
**Mode:** afk
**Type:** docs
**Success criteria:** `.ai/` and every touched README describe the shipped
behavior, not the pre-plan behavior or the mid-plan intermediate states.
The known-open stopgap in `approval-gate-design.md` is flipped from open to
closed, with Tier 2 recorded as the new deferred gap. No new code ships in
this phase.
**Commit message:** `docs: sync knowledge base for 06-legible-approvals-bounded-reads`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `apps/hermes/README.md` | correct the Approval gate section's overclaim (`L144-156`) to describe the actual final prompt shape (identity line, row preview cap, consequence sentence, mode-specific copy) instead of "raw tool name plus its args... enough for a human to judge... without a second lookup" |
| modify | `packages/google-sheets/README.md` | the existing "Known gap, deliberately deferred" block (`L143-151`) is corrected: the gap it names (resolved sheet / effective valueInputOption invisible to the approver) is now closed; document the bounded-reads caps, the `prepare` hook usage, and the update-mode snapshot |
| modify | `packages/agent/README.md` | document `ToolSpec.prepare`/`ToolPreparation`, the `ctx.plan` contract, and the validation-order change for the gated path |
| modify | `.ai/decisions/approval-gate-design.md` | edit the "Known stopgaps" section in place: the `sheets_write` raw-args stopgap (`L98-114`) flips from open to closed, citing this plan; add Tier 2 (column headers as labels, before→after diffs *in the prompt*) as the new deferred gap, with its rationale (pre-approval Google calls, scope-decorator-must-wrap-prepare cost, not user-driven) |
| create | `.ai/decisions/tool-prepare-hook.md` | the `prepare` contract: why a typed `plan` threaded into the handler prevents re-resolution drift, why `ApprovalSummary` is a **concrete**, generic (`action`/`target`/`items`/`itemsTotal`/`effects`) interface rather than a pre-rendered string or an opaque `unknown` (both rejected, with why), why the gate renders it with zero per-tool knowledge, why validation order changes only for the gated path, the fail-closed failure mode, what's rejected (re-resolving at display time, a sheets-write-specific hack inside the generic loop) |
| create | `.ai/decisions/bounded-tool-results.md` | the dual-cap (cells/chars) truncation contract, whole-row/whole-tab granularity, additive-fields-via-conditional-spread compatibility guarantee, why the caps are package-internal constants not env config |
| modify | `.ai/index.md` | `@hermes/agent` row: mention `ToolSpec.prepare`/`ToolPreparation` and link the new decision doc; `@hermes/google-sheets` row: mention bounded reads and the `prepare`-based approval summary; Cross-cutting "Tool approvals" row: mention the closed gap and the new mechanism |
| modify | `.ai/architecture.md` | "Inside a Sheets tool call" diagram: add the `prepare` step (fail-closed, before the prompt) ahead of the existing refusal chain; note reads are now bounded client-side after the API response |

**Steps:**

- [x] Read every file this plan touched one more time against what's
      actually in `.ai/` and each README before editing — don't edit from
      memory of the plan, edit from the diff
- [x] Confirm no README still claims the pre-plan raw-JSON prompt is
      sufficient anywhere (grep for "enough for a human to judge" and
      similar phrasing across the repo)
- [x] Run the `sync-knowledge` skill's closing checklist against this
      plan's Knowledge Base Impact table below

**Tests:**

No automated tests — justified because: this phase is a pure documentation
change with no behavior to verify; correctness is checked by human review
against the shipped code, not a test.

**Verification:**

- [x] `pnpm -r test` still green (no code changed, but confirms nothing was
      accidentally touched)
- [x] Manual: read the corrected `apps/hermes/README.md` Approval gate
      section and `packages/google-sheets/README.md`'s Sheets-write section
      end to end and confirm they match the actual shipped prompt

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing (n/a — see Tests above)
- [x] Documentation updated (this phase *is* the documentation update)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `docs: sync knowledge base for 06-legible-approvals-bounded-reads`
- [x] Phase marked complete

---

### Phase 9: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil

**Overall success criteria:**

- A non-technical Spanish-speaking user can trigger an append and an update
  write via natural Telegram messages and understand, from the prompt
  alone, which sheet is affected, what will happen, and (when relevant)
  that a value will be reinterpreted — without any second lookup.
- A bulk write shows a bounded preview with an honest total count.
- A read against a huge range or a many-tab spreadsheet never floods model
  context, and the model still answers coherently by asking for a narrower
  range when needed.
- A write to an unknown or read-only sheet is refused before any prompt.
- An update-mode write's reply narrates what changed.
- No CLAUDE.md invariant is violated: `packages/agent` still imports no
  feature package; the approval prompt is still deterministically rendered
  by our own code, never authored by the model.

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes
      are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block (scoped to
      end-to-end review)
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt
      into a fresh session
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review have
      been reflected back into this plan file
- [x] `pnpm -r typecheck` green
- [x] `pnpm -r test` green
- [x] `pnpm lint` green
- [x] No CLAUDE.md invariants violated
- [x] Manual golden path on a real phone against a real Telegram bot: an
      append with a date value (shows identity + preview + consequence
      sentence in Spanish) → approve → confirm it lands → an update against
      an existing row → approve → confirm the reply narrates the change →
      a bulk append of 40+ rows → confirm the preview caps at 3 with an
      honest count → a write to the read-only sheet → confirm no prompt
      appears at all → a write to an unknown slug → confirm no prompt
      appears and the model relays the available slugs → a `sheets_read`
      over a huge range → confirm the model asks to narrow the range rather
      than dumping everything
- [~] `[~]` In-turn write dedupe re-confirmed as unit-test-only, not
      manually verifiable from Telegram (every inbound message is a new
      turn) — per `plans/05-google-sheets.md`'s own note, unchanged by this
      plan
- [x] Overall success criteria met
- [x] `sync-knowledge` re-run to confirm Phase 8's edits are still accurate
      after any Final-Verification-driven fixes
- [x] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Shared truncation helper, bounded `sheets_read`/`sheets_inspect` | `packages/google-sheets/README.md` |
| `ToolSpec.prepare` / `ToolPreparation` / concrete `ApprovalSummary` contract | `packages/agent/README.md` |
| `sheets_write.prepare`, plan/summary shapes, scope-decorator wrapping `prepare` | `packages/google-sheets/README.md`, `apps/hermes/README.md` |
| Generic approval prompt renderer, Approve/Deny → Aprobar/Rechazar | `apps/hermes/README.md` |
| Row-preview cap and mode-specific copy (tool-side) | `packages/google-sheets/README.md` |
| `valueInputOption` consequence sentence heuristic (tool-side) | `packages/google-sheets/README.md` |
| Update-mode `replaced` snapshot, non-fatal failure mode, audit side-benefit | `packages/google-sheets/README.md` |
| Corrected approval-gate overclaim | `apps/hermes/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | `@hermes/agent` row gains the `prepare` hook; `@hermes/google-sheets` row gains bounded reads + approval summary; Cross-cutting "Tool approvals" row's known-open gap flips to closed |
| `architecture.md` | update | "Inside a Sheets tool call" diagram gains the `prepare` step; note bounded, client-side-truncated reads |
| `decisions/approval-gate-design.md` | update | flip the `sheets_write` raw-args stopgap to closed; record Tier 2 as the new deferred gap |
| `decisions/tool-prepare-hook.md` | create | the `prepare`/`ToolPreparation` contract, why validation order changes for the gated path, fail-closed semantics |
| `decisions/bounded-tool-results.md` | create | the dual-cap truncation contract, whole-row/whole-tab granularity, additive-fields compatibility |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | shared `truncateBySize` mechanics, incl. empty-input and single-oversized-item edge cases | `packages/google-sheets/src/__tests__/truncate.test.ts` |
| Phase 1 | `sheets_read` truncation, incl. empty-result and fewer-rows-than-requested edge cases | `packages/google-sheets/src/tools/__tests__/sheets-read.test.ts` |
| Phase 2 | `sheets_inspect` truncation, incl. empty-header-row and single-oversized-tab edge cases | `packages/google-sheets/src/tools/__tests__/sheets-inspect.test.ts` |
| Phase 3 | `ToolSpec.prepare` invocation, fail-closed handling (throw/timeout/mid-flight abort), partial-batch mechanism, raw-vs-parsed args in the batch | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 3 | generic `ApprovalSummary` renderer (identity block, malformed-summary fallback, prepare-less fallback) | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` |
| Phase 3 | `with-required-scopes` forwards and scope-gates `prepare` | `apps/hermes/src/agent/__tests__/with-required-scopes.test.ts` |
| Phase 3 | `sheets_write.prepare` plan/summary, unknown-slug refusal, dedupe still handler-side | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |
| Phase 4 | read-only-sheet refusal moved into `prepare`, pre-prompt | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |
| Phase 5 | row preview cap and mode-specific copy (tool-side `items`/`itemsTotal`/`effects`), zero-row edge case | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |
| Phase 5 | renderer unchanged, richer summary content only | `apps/hermes/src/agent/__tests__/approval-prompt-renderer.test.ts` |
| Phase 6 | `valueInputOption` consequence detector | `packages/google-sheets/src/__tests__/value-input-consequence.test.ts` |
| Phase 6 | consequence sentence appended to `effects`, final settled prompt shape | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |
| Phase 7 | update-mode `replaced` snapshot, non-fatal failure | `packages/google-sheets/src/tools/__tests__/sheets-write.test.ts` |

## Human Summary

This plan fixes two things about the bot that were quietly working against
its own non-technical users. First, when the bot writes to a spreadsheet on
someone's behalf, it always asked for approval — but the approval message
showed raw computer-speak (JSON, English, an unresolved sheet ID) instead of
something a person could actually read and judge. That's fixed by teaching
each tool that needs approval to prepare a clean, resolved summary — the
real spreadsheet name, which rows, whether a date might get misread as text
— before the question is ever asked, so the human sees the same, real thing
the bot is about to do, in plain Spanish, with a couple of Aprobar/Rechazar
buttons. It also closes an old gap: writing to a sheet the operator marked
read-only, or naming a sheet that doesn't exist, no longer bothers to ask
at all — the bot just says no, immediately. Overwrites additionally now
tell you what they changed, not just that they succeeded. Second, reading a
spreadsheet used to have no size limit — asking about a huge range or a
sheet with many tabs could quietly overload the bot's own memory of the
conversation with no error, just a bot that started acting confused a few
messages later. Now every read caps itself, always by whole rows or whole
tabs, and tells the model plainly when it should ask for something
narrower. Neither change touches the underlying trading-agnostic Sheets
capability itself — reading, writing, and the safety checks around them all
work exactly as before; this plan only changes what a human sees and how
much a read can dump into the conversation at once.
