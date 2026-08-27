# Plan: Agent Core (Roadmap Phase 2c)

**Created:** 2026-08-27
**Branch:** `feat/03-agent-core`
**Status:** not started

## Context

`01-llm-port` gave Hermes a single paid LLM call per Telegram message. `02-telemetry`
made that call observable (`llm.call` events, `/stats`) but left `ToolCallEvent`
and `TurnEvent` as typed, unproduced contracts, and documented plainly that
`/stats`' cache-hit rate reads `0.0%` because the only shared prefix across calls
is a ~9-token placeholder system prompt sent with no conversation history —
"one `complete()` per message: no tool loop, no history persistence yet — that's
`packages/agent`." This PRD is that package. ROADMAP §2c gives it four jobs:
turn a stateless single-shot reply into a real multi-turn conversation with
restart-safe history; give the model tools it can actually call, gated by an
approval step for anything the operator wants to review before it runs; reserve
— but not build — the seam for a second agent later (D4); and make the
cache-hit number `02-telemetry` shipped an instrument for finally move, by
giving the provider a real, growing, byte-stable shared prefix to cache against.

**Explicitly out of scope, owned by later PRDs:**

- **Real feature tools.** `get_current_time` and `echo` are throwaway,
  ROADMAP-named tools whose only job is to exercise the registry and the
  approval gate. No tool with a real side effect (search, calendar, file
  access, …) ships here.
- **Real context compaction / summarization.** This PRD ships the "crude"
  chars/4, drop-oldest trim ROADMAP §2c names explicitly. A tokenizer-accurate
  budget or a summarizing compactor is Phase 8 — an out-of-scope non-goal
  recorded here so it isn't rediscovered as a gap.
- **A provider registry or automatic failover (D5).** `AgentDefinition` carries
  one `model: string`; env-swap remains the only way to change it, exactly as
  `01-llm-port` shipped.
- **Tiered/escalation routing.** No hook, no escalation field, no new env var
  — `AgentDefinition.model` is it (settled decision 12).
- **A second agent, a manifest loader, or `agent_id` columns.** D4 is
  reserved, not built: `apps/hermes` passes one hardcoded `AgentDefinition[]`
  with a single entry at boot. Nothing here makes agent #2 more than a second
  list entry away, but nothing here adds that entry either.
- **OTel or any exporter for the telemetry events this PRD's loop and tool
  calls now actually produce** (`02-telemetry`'s D2 non-goal still holds).
- **Persisted approval state.** A pending approval lives in memory only
  (settled decision 6) — surviving a restart is explicitly not built.

**Packages created here**, per D3 ("create at its phase, never
merge-then-split"): `packages/agent` only.

**Packages modified here:** `packages/core` (`TurnEvent.outcome` narrowed from
`string` to a `TurnOutcome` union), `packages/llm` (port gains
`threadId`/`turnId` on the request and `costUsd` on the result; adapter stamps
real ids instead of hardcoded `null`s), `packages/store` (two new migrations —
`total_cost_usd` on `telemetry_events`, plus the new `threads` table — and a
`thread-repo.ts`), `packages/channels` (Phase 3 only: inline-keyboard support,
`callback_query` inbound), `apps/hermes` (boot wiring, the `complete.ts` swap,
two throwaway tool definitions, the Telegram approval-gate implementation).

## Risk: high

This PRD replaces the one paid call site `01-llm-port` and `02-telemetry` both
built around with a loop that can make up to 8 paid calls per inbound message,
introduces the first persistent, restart-surviving state Hermes has ever
carried (conversation history), and — in Phase 3 — adds a genuinely new
external surface (Telegram inline keyboards, `callback_query` inbound) with
state that is deliberately *not* persisted. Three things earn the "high" label
specifically. First, the abort-signal wiring: `02-telemetry`'s own Phase 6 found,
live, that the boot `AbortController`'s signal had been wired into the LLM
adapter but never into the Telegram poller — a mechanism tested but not
actually connected, the same bug class this repo has now hit twice. An 8-iteration
loop of paid calls that doesn't check that signal on every iteration reintroduces
exactly the hang that fix closed, at higher stakes (more paid calls in flight,
not one). Second, the byte-stable prefix: `/stats`' cache-hit rate only moves if
the system prompt plus tool definitions sent on every single call are
byte-identical, in the same order, every time — a single map-iteration-order
bug or an accidentally-included timestamp silently caps the cache-hit rate at
`0%` again, with no error and no obvious symptom. Third, the approval gate
combines a new persistence-adjacent invariant (thread history is durable,
approvals are not) with new Telegram wire surface (buttons, callbacks,
message edits) neither of which this codebase has built before.

## Dependencies & Risks

- **The abort signal is a required constructor dependency, not an optional
  one.** Per settled decision 3, `packages/agent`'s loop takes the boot
  `AbortSignal` as a mandatory argument — no default, no silent skip — and
  checks `signal.aborted` before every iteration and before every tool call.
  This is a deliberate reaction to the exact "mechanism built but never wired"
  trap `02-telemetry` Phase 6 found live in the Telegram poller. `LlmAbortedError`
  (reused from `packages/llm`, not a new type) propagates out of the loop and is
  never retried.
- **The drop-oldest context trim must never touch the prefix.** Settled decision
  8: the prefix is the static system prompt plus tool JSON Schemas, assembled
  deterministically (tools sorted by name, schema keys sorted), containing zero
  dynamic content — no dates, no user names, current time is a *tool*, not a
  prompt line. Settled decision 9's chars/4 drop-oldest trim operates
  exclusively on stored conversation history; the newest user message is never
  trimmed away (it is appended *after* trimming, not before). A prefix that
  drifts by even one byte between calls resets the provider's cache and keeps
  `/stats`' cache-hit rate at the `0%` `02-telemetry` shipped it at.
- **The `cost_usd` double-count `02-telemetry` deferred is fixed here, not
  reopened.** Settled decision 1: new migration adds `total_cost_usd
  numeric(12,6)` to `telemetry_events`; `turn` events write `totalCostUsd`
  there and leave `cost_usd` `NULL`; `cost_usd` keeps exactly one meaning — the
  cost of a single `llm.call`. `.ai/decisions/telemetry-event-schema.md`'s open
  item on this is resolved as part of Phase 1, not left for later.
- **`packages/agent` never imports a feature package — this *is* the D4 seam.**
  Settled decision 10: `get_current_time` and `echo` are defined in
  `apps/hermes` and passed into `AgentDefinition.tools` at boot.
  `packages/agent` only knows `ToolSpec` (name, description, zod schema,
  handler, `requiresApproval`) and never imports anything from `apps/hermes`.
  No mutable `register()` — tools are supplied once, at construction, because
  registration-order nondeterminism would threaten the byte-stable prefix.
- **Thread persistence is one thread per channel+chat, full messages in JSONB
  — no separate messages table, no partial-history reads.** `packages/agent`
  depends on an injected `ThreadRepo` port, never `@hermes/store` directly —
  the same boundary rule `packages/llm` already follows for `LlmUsageRepo`/
  `BudgetUsageRepo`. Full history is always persisted; the chars/4 trim only
  ever affects what is sent to the model on a given call, never what is stored.
- **The LLM port's `CompletionRequest` gains `threadId`/`turnId` as required
  fields, not optional ones.** Every existing test in `packages/llm` that
  constructs a `CompletionRequest` literal breaks and needs
  `threadId`/`turnId` added — a mechanical but wide change, called out
  explicitly in Phase 1's Steps so it isn't rediscovered mid-implementation.
  Required (not optional-with-a-`null`-default) for the same reason the abort
  signal is required: this codebase has twice shipped an optional field that
  the real construction site silently never filled in.
- **Approval gate: one combined prompt for a whole batch, held in memory, not
  persisted, timeout is denial, abort resolves it immediately.** Settled
  decisions 5–7, 16: a single Telegram message lists every gated call in one
  model response and is approved/denied as a group (the user's own override
  of the more granular per-call default); non-gated calls in the same batch
  execute concurrently regardless. Resolution — by tap, by the 5-minute
  timer, or by the boot `AbortSignal` firing — is **one code path**: it
  synchronously removes the pending entry from the in-memory map *before* any
  `await` (including `editMessage`), so a timer and a late tap can never both
  resolve the same approval, and a `callback_query` that arrives after
  resolution — already-answered, or the map is empty because the process
  restarted — finds no entry and gets the identical "this approval has
  expired, ask again" reply; restart and already-answered are the same
  branch, not two. `ApprovalGate.requestApproval` takes the loop's
  `AbortSignal` as a parameter for exactly this reason: an abort while a
  batch is pending must resolve every open approval as `"denied"` and clear
  its timer immediately, not leave the promise parked until the 5-minute
  timeout (or forever, past the 8s hard-exit budget) — the same
  `delay(ms, signal)` helper backs both the timeout and the abort race, no
  separate mechanism. An unanswered approval after 5 minutes resolves as
  denied, the tool result becomes "user did not approve," and the loop
  *continues* so the model can respond — only the iteration cap, an abort, or
  an LLM-level failure end a turn (settled decision 13/15).
- **Tool failures — a handler throwing is never terminal; bad args get
  exactly one corrective round-trip via a per-call retry counter.** Settled
  decision 15: a handler throw always becomes a tool result the model sees,
  and the loop continues. "One retry" (settled decision, ROADMAP §2c) is
  implemented as a **per-tool-call retry counter**, not "just let the next
  loop iteration happen": `runTurn` holds a `Map<toolName, number>` scoped to
  that turn (reset every call, never persisted across turns — a provider
  issues a fresh `ToolCall.id` on every iteration, so there is no stable id
  to key retries on across iterations; tool name is the only thing that
  survives a retry). The first zod validation failure for a given tool name
  increments its count to 1 and feeds the validation error back as that
  call's tool result, giving the model one chance to correct it on the next
  iteration. If a call to the **same tool name** fails validation again —
  pushing the count to 2, whether that second failure lands in the same
  iteration's batch or a later one — the loop stops retrying it and returns a
  terminal `"invalid arguments, giving up: <zod error>"` tool result so the
  model moves on rather than trying a third time; the count is never
  decremented by an intervening success. Worst case for one bad tool is 2
  paid calls, not 8. This is decided, not open for Phase 2 to relitigate.
- **`UnpricedModelError` (and any other `LlmProvider` throw) takes the same
  generic path as every other provider failure.** No special-casing:
  `runTurn` catches it exactly like any other thrown error, emits a `turn`
  event with `outcome: "error"`, `totalCostUsd: 0`, and rethrows unchanged.
  Named here so it isn't rediscovered as a gap during Phase 1 review.
- **No new index needed for `turn_id`/`thread_id`.** Checked directly:
  `004_telemetry_events.sql` indexes `created_at`, `(name, created_at)`, and a
  partial index on `tool_name`; nothing indexes `turn_id` or `thread_id`.
  This PRD adds no repeated query that filters or joins on either column —
  thread lookup stays on the already-uniquely-indexed `(channel, chat_id)`,
  and the Final Verification's `turn_id` join is a one-off manual `psql`
  check, not a hot path. Reviewed and confirmed as a non-issue, not an
  oversight.
- **Every timeout in this PRD reuses `delay(ms, signal)` from `@hermes/core`
  (`packages/core/src/delay.ts`) — no bespoke `setTimeout`.** It already
  resolves on either the timer or the signal aborting, clearing both on
  either path, and `packages/llm`/`packages/channels` already depend on it
  for the same reason. Two new call sites: the approval gate's 5-minute
  window (Phase 3), and the per-tool-call handler timeout (Phase 2, a gap
  this review found — see that phase's Steps).
- **`TurnEvent.outcome` is narrowed, not widened.** Settled decision 13:
  `TurnOutcome = "completed" | "max_iterations" | "aborted" | "error"`.
  Approval denial and a validation failure are not outcomes — they don't end
  a turn.
- **Migration numbering is provisional.** This plan assumes `004_telemetry_events.sql`
  is still the highest migration (per `02-telemetry`'s own shipped state) and
  names the two new ones `005_telemetry_event_total_cost.sql` and
  `006_threads.sql`. Whoever executes Phase 1 must re-list
  `packages/store/src/migrations/` first and number one past whatever is
  actually there — the same caveat `02-telemetry` Phase 1 carried and got
  right.
- **The cache-hit-rate success bar is cumulative across this whole PRD, not a
  single phase's job.** Settled decision 17: Final Verification requires a
  real multi-turn Telegram conversation where `/stats` reports a cache-hit
  rate above `0.0%` — this only becomes possible once Phase 1 ships growing,
  byte-stable history, and the live check itself waits until Phase 4. A unit
  test proving the prefix is byte-identical across two independent
  assemblies is necessary but not sufficient — it proves determinism, not
  that a provider actually cached it, and both are required.
- **No new dependency.** `packages/agent` depends on `@hermes/core`,
  `@hermes/llm` (the `LlmProvider`/`CompletionRequest`/`Message` types), and
  `zod` — already a workspace dependency (`@hermes/config` uses it; `zod`
  3.25.76 ships the `zod/v4` subpath with `z.toJSONSchema`, no new package
  needed). Nothing here needs a `.ai/decisions/` justification under the
  dependency policy.
- **CI already exists** (`02-telemetry` Phase 5). This plan adds no new live
  provider surface and no new excluded test lane — the existing `test`/`test:db`
  CI lanes cover everything here automatically; no CI changes are made.

---

### Phase 0: Create worktree

**This phase is always first. No exceptions.**

Follows the same sibling-worktree convention `01-llm-port` and `02-telemetry`
used.

**Steps:**

- [ ] Confirm with the user: branch name `feat/03-agent-core`, base ref `main`
- [ ] `git worktree add ../hermes-03-agent-core -b feat/03-agent-core main`
- [ ] Verify worktree is active and on the correct branch: `git worktree list`
- [ ] **Explicit step, do not skip:** copy `.env` from the repo root into the
      new worktree (`../hermes-03-agent-core/.env`) — gitignored, so the
      worktree starts without it.

---

### Phase 1: Multi-turn conversation with restart-safe history, no tools yet

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** A Telegram conversation with the bot has real memory —
message 2 can refer to message 1 and the reply shows it. Restarting the
container mid-conversation and sending a follow-up still has that memory
(history read back from `threads`, not lost). Every turn produces a `turn`
telemetry row (`iterations`, `total_cost_usd`, `outcome`, `duration_ms`) and
every LLM call inside it now carries the real `thread_id`/`turn_id` instead of
`null`/`null`. No tool exists yet — the loop's only job this phase is: load
thread, trim history, call the model once, persist, reply. (Live confirmation
that `/stats`' cache-hit rate has actually moved off `0.0%` is deferred to
Phase 4 — it needs several real turns of history to show up, which only
becomes possible once this phase ships.)
**Commit message:** `feat: agent package, multi-turn history, wired into the completion path`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `packages/store/src/migrations/005_telemetry_event_total_cost.sql` | `ALTER TABLE telemetry_events ADD COLUMN total_cost_usd numeric(12,6);` — resolves the `cost_usd` double-count `02-telemetry` deferred (settled decision 1). **Provisional number — re-verify `004` is still highest before creating this file** |
| create | `packages/store/src/migrations/006_threads.sql` | `CREATE TABLE threads (id uuid primary key default gen_random_uuid(), channel text not null, chat_id text not null, messages jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (channel, chat_id));` plus an index on `(channel, chat_id)` (the unique constraint already covers lookup, but name it explicitly for the `getOrCreateThread` query path). **Provisional number — depends on `005` above** |
| modify | `packages/store/src/telemetry-event-repo.ts` | `toRow()`'s `turn` branch writes `totalCostUsd` into the new `total_cost_usd` column and leaves `cost_usd` `NULL`; `llm.call`/`tool.call` branches unchanged |
| create | `packages/store/src/thread-repo.ts` | `getOrCreateThread(pool, channel: string, chatId: string): Promise<Thread>` — `INSERT ... ON CONFLICT (channel, chat_id) DO NOTHING RETURNING *`, then a `SELECT` on conflict. **Confirmed, not left open:** `llm-dedupe-repo.ts` is the only existing upsert precedent in `packages/store` (`INSERT ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`) — there is no `ON CONFLICT DO UPDATE` precedent anywhere in this codebase, so `getOrCreateThread` matches the `DO NOTHING` style rather than inventing a new idiom. Returns `{ id, channel, chatId, messages: Message[] }`; `appendMessages(pool, threadId: string, newMessages: Message[]): Promise<void>` — `UPDATE threads SET messages = messages \|\| $2::jsonb, updated_at = now() WHERE id = $1`, appending rather than replacing so a concurrent read never sees a partial write |
| modify | `packages/store/src/index.ts` | export `getOrCreateThread`, `appendMessages`, `Thread` |
| modify | `packages/store/README.md` | document `threads`: one row per `(channel, chat_id)`, full untrimmed history in `messages` jsonb, no size cap or archival policy yet (explicit open item, same shape as `telemetry_events`' unbounded-growth note) |
| modify | `packages/core/src/telemetry.ts` | narrow `TurnEvent.outcome` from `string` to `TurnOutcome = "completed" \| "max_iterations" \| "aborted" \| "error"` |
| modify | `packages/core/src/index.ts` | export `TurnOutcome` |
| modify | `packages/llm/src/port.ts` | `CompletionRequest` gains required `threadId: string \| null` and `turnId: string \| null`; `CompletionResult` gains required `costUsd: number` |
| modify | `packages/llm/src/adapter/openai-compatible.ts` | `complete()` stamps `request.threadId`/`request.turnId` onto the `llm.call` event instead of hardcoded `null`s (both the success and the error emission branches); returns `costUsd: entry.costUsd` on the successful `CompletionResult`, reusing the same `LlmUsageEntry` `02-telemetry` already made `recordCompletionUsage` return — no second cost derivation |
| modify | `packages/llm/src/**/__tests__/*.test.ts` | every `CompletionRequest` fixture gains `threadId`/`turnId` (grep-and-fix, see Steps) |
| modify | `packages/llm/README.md` | document the new required request fields and the result's `costUsd` |
| create | `packages/agent/package.json`, `tsconfig.json` | new workspace package templated on `packages/llm`'s shape: `type: module`, `dist` main/types, `files: ["dist"]`, `typecheck`/`build`/`test` scripts; dependencies `@hermes/core`, `@hermes/llm`, `zod` |
| create | `packages/agent/src/types.ts` | `Message` (re-exported or mirrored from `@hermes/llm`'s port — reuse, don't redefine, if the shape already exists there); `ToolSpec { name: string; description: string; schema: z.ZodTypeAny; handler: (args: unknown, ctx: { signal: AbortSignal }) => Promise<unknown>; requiresApproval: boolean }`; `AgentDefinition { name: string; model: string; systemPrompt: string; tools: ToolSpec[]; channels: string[] }` — the D4 seam, populated once at boot from a hardcoded list |
| create | `packages/agent/src/prompt.ts` | `assemblePrefix(definition: AgentDefinition): { system: string; toolDefs: ToolDefinition[] }` — `system` is `definition.systemPrompt` verbatim (static, zero dynamic content); `toolDefs` derives each tool's JSON Schema via `z.toJSONSchema(spec.schema)`, with `definition.tools` sorted by `name` first and each schema's own keys emitted in a stable (sorted) order — deterministic and byte-identical across two independent calls with the same `definition`, proven with `definition.tools = []` this phase (real tools arrive in Phase 2 and reuse this same function unmodified) |
| create | `packages/agent/src/context-trim.ts` | `trimHistory(messages: Message[], budgetChars: number): Message[]` — estimates each message's size as `content.length / 4` (chars/4 token estimate, settled decision 9), drops the oldest messages first until the running total is under `budgetChars`; never touches the prefix (the caller applies this only to stored history, not to `system`/`toolDefs`); `HISTORY_BUDGET_CHARS` is a package-internal constant (not env-configurable, same posture as `02-telemetry`'s `maxBufferSize`) |
| create | `packages/agent/src/thread-repo-port.ts` | `Thread { id: string; channel: string; chatId: string; messages: Message[] }`; `ThreadRepo { getOrCreateThread(channel: string, chatId: string): Promise<Thread>; appendMessages(threadId: string, messages: Message[]): Promise<void> }` — the injected port; `packages/agent` never imports `@hermes/store` |
| create | `packages/agent/src/loop.ts` | `runTurn(definition: AgentDefinition, deps: { llmProvider: LlmProvider; threadRepo: ThreadRepo; telemetryRecorder?: TelemetryRecorder; signal: AbortSignal }, channel: string, chatId: string, userText: string): Promise<string>` — this phase's shape: load/create the thread; check `deps.signal.aborted` (throw `LlmAbortedError` if so, no LLM call attempted); assemble the prefix; trim stored history to `HISTORY_BUDGET_CHARS`; call `llmProvider.complete({ model, system, messages: [...trimmed, { role: "user", content: userText }], tools: undefined, maxTokens: MAX_TOKENS_PER_TURN, threadId: thread.id, turnId })` with a freshly generated `turnId` (`newId()`); if `result.toolCalls.length > 0`, throw (`tool calls are not supported until packages/agent Phase 2` — a defensive, temporary guard removed in Phase 2, not a real code path since `tools: undefined` means no provider should ever return one); on success, `appendMessages` the user message and the assistant reply together in one call, emit `{ name: "turn", threadId: thread.id, turnId, iterations: 1, totalCostUsd: result.costUsd, outcome: "completed", durationMs }`, return `result.text`; on any thrown error (abort, provider failure, the defensive guard above), emit a `turn` event with `outcome: "aborted"` (for `LlmAbortedError`) or `"error"` (anything else — including `UnpricedModelError`, which gets no special-casing), `totalCostUsd: 0`, then **rethrow the original error unchanged** so the existing completion handler's generic-failure reply still applies — no new error-handling branch. `MAX_ITERATIONS = 8` is declared as a package-internal constant here even though this phase's traffic can never reach iteration 2 (no tools means `toolCalls` is always empty) — Phase 2 is the first phase that can actually exercise it |
| create | `packages/agent/src/index.ts` | public exports: `createAgent` (thin factory wrapping `runTurn` + the injected deps into an `{ handleMessage(channel, chatId, text): Promise<string> }` object), `AgentDefinition`, `ToolSpec`, `ThreadRepo`, `Thread`, `Message` |
| create | `packages/agent/README.md` | the loop's shape this phase (single-call, no tools), the byte-stable prefix contract, the chars/4 trim and what it does/doesn't touch, the required `AbortSignal` dependency, the D4 seam (`AgentDefinition` is the only multi-agent surface reserved, nothing else) |
| create | `apps/hermes/src/store/build-thread-repo.ts` | `buildThreadRepo(pool: Pool): ThreadRepo` — wires `@hermes/store`'s `getOrCreateThread`/`appendMessages`, matching `build-llm-provider.ts`'s shape |
| create | `apps/hermes/src/agent/build-agent.ts` | `buildAgent(pool: Pool, llmProvider: LlmProvider, telemetryRecorder: TelemetryRecorderHandle, signal: AbortSignal): Agent` — the only place allowed to import both `@hermes/config` and `@hermes/agent`; constructs the one hardcoded `AgentDefinition` (`model` from the existing resolved primary-model config, `systemPrompt` = the text currently in `complete.ts`'s `SYSTEM_PROMPT_PLACEHOLDER`, `tools: []` this phase, `channels: ["telegram"]` — **verify the existing channel-identifier convention at execution time**, use whatever string the codebase already uses rather than inventing one) |
| modify | `apps/hermes/src/handlers/complete.ts` | remove `SYSTEM_PROMPT_PLACEHOLDER` (moved into `build-agent.ts`); `replyWithCompletion()` calls `agent.handleMessage(channel, chatId, userText)` in place of the single `llmProvider.complete()` call, keeping every surrounding line — the `llm_dedupe` claim → reply → complete ordering — exactly as-is (settled decision 11) |
| modify | `apps/hermes/src/boot.ts` | `createMessageHandlers` builds `threadRepo = buildThreadRepo(pool)` and `agent = buildAgent(pool, llmProvider, telemetryRecorder, controller.signal)`, threading `agent` into whatever deps object `replyWithCompletion` already receives |
| modify | `tsconfig.base.json` | add `@hermes/agent` to `paths` |
| modify | `Dockerfile` | add `COPY packages/agent/package.json packages/agent/package.json` to the manifest copy list |
| modify | `apps/hermes/README.md` | document that completions now go through the agent loop, history persists per `(channel, chat_id)`, and the current turn has no tools |

**Steps:**

- [ ] **Re-list `packages/store/src/migrations/` first** and confirm `004` is
      still the highest-numbered file before creating `005`/`006` — do not
      trust this plan's assumed numbers if the directory has moved on
- [ ] Narrow `TurnEvent.outcome` in `@hermes/core` before anything else in this
      phase depends on it
- [ ] Migrations `005` (additive `ALTER TABLE`, no backfill needed — existing
      `turn` rows, if any, simply keep `total_cost_usd` `NULL`) and `006`,
      following `001`–`004`'s conventions (own transaction, tracked in
      `schema_migrations`, applied by the existing `runMigrations`)
- [ ] `getOrCreateThread`/`appendMessages`: use the `INSERT ... ON CONFLICT
      DO NOTHING RETURNING *` + `SELECT`-on-conflict shape, matching
      `llm-dedupe-repo.ts` — confirmed during plan review as the only
      existing upsert idiom in `packages/store`; do not introduce
      `ON CONFLICT DO UPDATE` as a new pattern
- [ ] **Widen `CompletionRequest`/`CompletionResult` and grep-fix every
      existing fixture in `packages/llm`'s test suite.** This is mechanical
      but touches every adapter test file — do it as one focused pass
      (`grep -rn "system:" packages/llm/src/**/__tests__` or similar to find
      every literal), not scattered across later steps
- [ ] `assemblePrefix`: prove determinism with `definition.tools = []` this
      phase — two independent calls with the same definition produce
      byte-identical `system` and `toolDefs` output (an empty-array
      `toolDefs` is still a meaningful assertion: it proves the function is
      pure and takes no hidden dynamic input, which is what Phase 2 depends on
      when tools become non-empty)
- [ ] `trimHistory`: the newest user message is **never** passed into
      `trimHistory` — it's appended to the trimmed result afterward, so it can
      never be dropped even if it alone exceeds `HISTORY_BUDGET_CHARS`. Test
      this specifically, not just "trims oldest first"
- [ ] `runTurn`'s persistence order: append user + assistant messages
      **together, in one `appendMessages` call, only on success** — a failed
      call (provider error, abort) does not record the user's message either,
      consistent with `llm_dedupe`'s one-inbound-message-equals-one-attempt
      contract (no retry means nothing to replay into history)
- [ ] Confirm `deps.signal.aborted` is checked **before** the LLM call is
      attempted, not just relied on via the adapter's own abort plumbing —
      this loop must fail fast on an already-aborted signal rather than
      starting a call it can't finish
- [ ] Wire `buildThreadRepo`/`buildAgent` into `boot.ts`'s real construction
      site, not just build them — the same "mechanism proven, wiring
      dropped" trap flagged twice already in this codebase's history. Add a
      wiring-pin test (see Tests) asserting the real `boot.ts` path actually
      constructs and passes a real `ThreadRepo`/`Agent`, not a stub
- [ ] `apps/hermes/src/agent/build-agent.ts`: confirm the existing channel
      identifier string (however `apps/hermes` already names "telegram"
      internally, if at all) before inventing a new constant

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `packages/store/src/__tests__/thread-repo.test.ts` (test:db) | `getOrCreateThread` is idempotent for the same `(channel, chatId)` (second call returns the same row, doesn't create a duplicate); `appendMessages` appends without clobbering existing entries, and bumps `updated_at`; a fresh thread starts with `messages = []` |
| create | `packages/agent/src/__tests__/prompt.test.ts` | `assemblePrefix` with `tools: []` is byte-identical across two independent calls with the same definition; changing `systemPrompt` changes `system`; the function takes no implicit dynamic input (no `Date.now()`, no random ids) |
| create | `packages/agent/src/__tests__/context-trim.test.ts` | drops oldest-first once over budget; keeps everything when under budget; a single message larger than the whole budget is still kept if it's the only one; confirms the function never receives (and thus never drops) the "current" user message — that's the caller's job, asserted by contract, not by this test alone |
| create | `packages/agent/src/__tests__/loop.test.ts` | happy path: a fake `LlmProvider` returning `toolCalls: []` produces one `turn` event (`iterations: 1`, `outcome: "completed"`, `totalCostUsd` matching the fake result's `costUsd`) and persists user+assistant messages via a fake `ThreadRepo`; an already-aborted `signal` throws `LlmAbortedError` before the fake provider is ever called, and emits a `turn` event with `outcome: "aborted"`; a fake provider that rejects emits `outcome: "error"` and rethrows the original error unchanged; a fake provider returning a non-empty `toolCalls` throws the Phase-1 defensive guard (proving the stub is reachable and correctly temporary) |
| modify | `packages/llm/src/adapter/__tests__/openai-compatible*.test.ts` | every fixture gains `threadId`/`turnId`; add one assertion that a supplied `threadId`/`turnId` is stamped onto the emitted `llm.call` event instead of `null`/`null`; add one assertion that a successful `complete()`'s result carries `costUsd` matching the emitted event's `costUsd` |
| create | `apps/hermes/src/agent/__tests__/build-agent.test.ts` | pure wiring test, no real DB: `buildAgent` returns something whose `handleMessage` delegates to the injected `llmProvider`/`threadRepo`/`telemetryRecorder`, matching `build-llm-provider.test.ts`'s shape |
| modify | `apps/hermes/src/handlers/__tests__/complete.test.ts` | `replyWithCompletion` now calls the injected `agent.handleMessage` instead of `llmProvider.complete` directly — update the fake deps and existing assertions accordingly; the `llm_dedupe` ordering test(s) still pass unmodified in spirit (claim → reply → complete order unchanged) |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] `pnpm test:db` green — migrations `005`/`006` apply cleanly, thread
      repo round-trips for real
- [ ] `docker compose build` succeeds (catches a missing `Dockerfile` COPY line)
- [ ] Manual: message the bot twice in the same chat, second message
      referencing the first ("what did I just say?") → the reply shows real
      memory
- [ ] Manual: `docker compose restart hermes`, send a follow-up message in the
      same chat → the bot still has the earlier context (read back from
      `threads`, not from an in-process cache)
- [ ] Manual: `psql` into the app database after a turn → one new `turn` row
      with `iterations = 1`, `outcome = 'completed'`, `total_cost_usd` set and
      `cost_usd` `NULL`; the corresponding `llm.call` row has real
      `thread_id`/`turn_id`, not `NULL`

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: agent package, multi-turn history, wired into the completion path`
- [ ] Phase marked complete

---

### Phase 2: Tool registry, `get_current_time`, zod validation, retry, parallel execution

**Risk:** medium
**Mode:** afk
**Type:** backend
**Success criteria:** Ask the bot "what time is it?" — it calls `get_current_time`
and answers with a real timestamp. A `tool.call` telemetry row lands
(`tool_name = 'get_current_time'`, `approved = true`, correct `duration_ms`),
and `/stats`' top-tools section (built, unused, in `02-telemetry`) now shows it
instead of "no tool calls recorded yet." Two tool calls requested in the same
model turn execute concurrently, not sequentially. A deliberately malformed
tool-call argument gets exactly one corrective round-trip: the model sees the
validation error and can fix it on its next attempt; if the same tool's args
fail validation a second time, the loop stops retrying it, returns a terminal
"invalid arguments" tool result, and continues so the model can respond —
worst case 2 paid calls for one bad tool, not 8.
**Commit message:** `feat: tool registry, get_current_time, parallel execution with retry`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/agent/src/loop.ts` | replace the Phase 1 "tool calls not supported" guard with real handling: for each `toolCall` in `result.toolCalls`, look up the `ToolSpec` by name in a `Map` built once from `definition.tools`; an unknown tool name produces a tool result `"unknown tool: <name>"` (fed back, loop continues — settled decision 15's error-recovery shape, applied uniformly); a known tool's `args` are `spec.schema.safeParse`d — on failure, `runTurn` reads/increments a `Map<toolName, number>` scoped to the turn (see Dependencies & Risks' "per-call retry counter"): count 1 → the tool result is the zod error message, fed back for the model's one corrective attempt; count 2 → the tool result is a terminal `"invalid arguments, giving up: <zod error>"` and this tool name gets no further corrective feedback for the rest of the turn (a third bad call still runs the loop and gets the terminal message again — it just never resets to a fresh "try again" hint); on successful validation, `spec.handler(args, { signal: deps.signal })` runs inside a `Promise.race` against `delay(TOOL_HANDLER_TIMEOUT_MS, deps.signal)` (reused from `@hermes/core`) so a handler that never returns produces a tool result `"tool timed out after <ms>ms"` instead of stalling the whole turn — checking `deps.signal.aborted` immediately before invocation as before; **all tool calls in one model response execute concurrently** via `Promise.all` (not gated ones this phase — every tool here is `requiresApproval: false`; `.map()` dispatches every handler's body up to its first `await` synchronously, so there is no event-loop gap between calls for an abort to land "between" them — one pre-invocation check per call is sufficient), and a handler that throws produces a tool result carrying the thrown error's message (settled decision 15) rather than aborting the turn; each tool call emits its own `{ name: "tool.call", threadId, turnId, tool: spec.name, durationMs, approved: true, error?: <truncated to 500 chars> }` — `approved: true` unconditionally this phase, since no gate exists yet; after all results are collected, they're appended as tool-result messages and the loop calls the LLM again (iteration + 1, capped at `MAX_ITERATIONS`); reaching the cap without a final text response emits `outcome: "max_iterations"` |
| modify | `packages/agent/src/loop.ts` (constants) | `TOOL_HANDLER_TIMEOUT_MS` declared as a package-internal constant (same posture as `MAX_ITERATIONS`/`HISTORY_BUDGET_CHARS` — not env-configurable) bounding a single tool handler invocation, independent of the turn-level iteration cap |
| modify | `packages/agent/src/loop.ts` (request construction) | `tools: definition.tools.length > 0 ? assemblePrefix(definition).toolDefs : undefined` passed to `llmProvider.complete()` — this is the first phase real tool definitions are ever sent to a provider |
| modify | `packages/agent/README.md` | document tool execution: registry built once at construction (no mutable `register()`), zod validation with the two-strikes per-call retry counter (first failure corrective, second failure terminal, keyed per tool name per turn), a per-tool-call handler timeout, parallel execution, per-call `tool.call` telemetry, unknown-tool and handler-throw both feed back rather than aborting the turn |
| create | `apps/hermes/src/agent/tools/get-current-time.ts` | `ToolSpec`: `name: "get_current_time"`, `schema: z.object({})` (no arguments), `handler: async () => new Date().toISOString()`, `requiresApproval: false` — the ROADMAP-named throwaway tool, defined in `apps/hermes` per the D4-seam boundary rule, never in `packages/agent` |
| modify | `apps/hermes/src/agent/build-agent.ts` | `AgentDefinition.tools` gains `[getCurrentTimeTool]` |
| create | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts` | handler returns a valid ISO-8601 string close to "now" |

**Steps:**

- [ ] Build the tool `Map` once per `runTurn` call (or once per `AgentDefinition`
      if it's safe to cache — confirm no per-turn state leaks into it) from
      `definition.tools`, keyed by `name` — this is "the registry," not a new
      standalone module; keep it inside `loop.ts` unless it grows large enough
      to earn its own file (it doesn't yet, with one tool)
- [ ] Zod validation failure and unknown-tool-name both produce a tool-result
      message the model sees — write a test proving the loop does **not**
      throw or abort the turn in either case, only in the max-iteration,
      abort, or LLM-failure cases
- [ ] **Two-strikes retry counter**: write a test where the same tool name
      fails validation twice across two iterations — assert the first
      failure's tool result is the raw zod error (corrective), the second
      failure's tool result is the terminal "invalid arguments, giving up"
      message, and — critically — the loop *continues* past the second
      failure (a further iteration happens; `outcome` is not set to
      `"error"` on account of the bad tool call alone) rather than ending the
      turn. Also assert the counter is keyed per tool name, not globally: a
      second, different tool failing validation for the first time still
      gets its own corrective round-trip in the same turn
- [ ] **Tool handler timeout**: fake-timers test with a handler that never
      resolves — assert the turn still completes (or reaches the next
      iteration) within `TOOL_HANDLER_TIMEOUT_MS`, the timed-out tool's
      result reads "tool timed out," and other tool calls in the same batch
      are unaffected
- [ ] Parallel execution: the test for this must prove actual concurrency, not
      just "both ran" — e.g., two fake handlers that each await a shared
      gate/flag set by the other, provably deadlocking if run sequentially and
      succeeding if run in parallel (same rigor `02-telemetry`'s recorder
      applied to proving its own concurrency claims)
- [ ] `tool.call`'s `error` field truncated to 500 chars at the emission site
      (matching `02-telemetry`'s settled decision 14 for `llm.call`'s `error`
      — apply the same bound here, don't leave it unbounded)
- [ ] Confirm `assemblePrefix`'s determinism test from Phase 1 still holds
      now that `definition.tools` is non-empty — extend, don't duplicate, that
      test file
- [ ] Confirm `getTopToolsSince` (already shipped, unused, in `02-telemetry`)
      needs **no code change** to start returning `get_current_time` rows —
      if it does need a change, that's a signal something about the `tool.call`
      event shape drifted from what `02-telemetry` actually shipped; re-check
      against the real `packages/store/src/telemetry-stats-repo.ts` rather
      than this plan's assumption

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/agent/src/__tests__/loop.test.ts` | a fake provider returning one `toolCalls` entry matching a registered tool: the handler is invoked, its result appended, the provider called again, and the loop completes on the second response's text; unknown tool name → tool result contains "unknown tool," loop continues, no throw; invalid args (schema mismatch) → tool result contains the validation error, loop continues; **the same tool failing validation twice → first failure's result is the corrective zod error, second failure's result is the terminal "invalid arguments, giving up" message, loop continues (not `outcome: "error"`) into a further iteration**; a handler that throws → tool result carries the thrown message, loop continues; a handler that never resolves → tool result reads "tool timed out," loop continues, unaffected sibling calls in the same batch still complete; two tool calls in one response execute concurrently (the deadlock-detecting fixture from Steps); a fake provider that always returns a tool call hits `MAX_ITERATIONS` and emits `outcome: "max_iterations"` with `iterations: 8` |
| create | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts` | see File changes |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] Manual: ask the bot "what time is it right now?" → reply includes a real
      current time; `psql` shows a `tool.call` row with `tool_name =
      'get_current_time'`, `approved = true`, a small positive `duration_ms`
- [ ] Manual: `/stats` → top-tools section now lists `get_current_time` instead
      of "no tool calls recorded yet"

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: tool registry, get_current_time, parallel execution with retry`
- [ ] Phase marked complete

---

### Phase 3: Approval gate, `echo`, Telegram inline keyboards

**Risk:** high
**Mode:** afk
**Type:** backend
**Success criteria:** Ask the bot to echo something. It replies with a single
Telegram message showing Approve/Deny buttons naming the pending call. Tapping
Deny blocks execution — the model is told the user didn't approve and answers
accordingly, without running `echo`. Tapping Approve runs it and the message
updates to a resolved state so the buttons can't be tapped again. Leaving the
prompt untouched for 5 minutes resolves it as denied on its own. A batch with
two gated calls shows one combined prompt, not two. This makes
`capabilities.buttons: true` (declared, unimplemented, since `packages/channels`
shipped) actually true.
**Commit message:** `feat: approval gate with Telegram inline keyboards, echo tool`

**File changes:**
| Action | File | What changes |
|---|---|---|
| modify | `packages/channels/src/channel.ts` | **Confirmed, not TBD:** `Channel.send(target: string, text: string): Promise<void>` today (`channel.ts:43`) returns nothing; `subscribe(handler): void` (line 42) is single-handler, `InboundMessage`-only. Widen to `send(target: string, text: string, options?: { buttons?: { label: string; callbackData: string }[][] }): Promise<{ messageId: string }>` — additive, non-breaking (existing callers ignore the new optional arg and return value). The message id isn't new capability: the low-level Telegram `client.ts`'s `sendMessage` already resolves `{ message_id: number }` — this just surfaces it through the `Channel` port. Add `editMessage(target: string, messageId: string, text: string): Promise<void>` and `answerCallback(callbackId: string, text?: string): Promise<void>` to the port. Add a normalized inbound "callback" kind alongside the existing inbound-message kind `subscribe` emits |
| modify | `packages/channels/src/telegram/client.ts` | add `answerCallbackQuery(callbackQueryId, text?)`, `editMessageText(chatId, messageId, text)`; `sendMessage` gains an optional `reply_markup` (inline keyboard) parameter and returns the sent message's `message_id` |
| modify | `packages/channels/src/telegram/*` (poller/types) | `allowedUpdates` gains `"callback_query"`; `TelegramUpdate` gains the `callback_query` shape; the poller normalizes a `callback_query` update into the new inbound "callback" kind |
| modify | `packages/channels/README.md` | document the callback inbound kind, `editMessage`/`answerCallback`, and that `capabilities.buttons` is now real |
| create | `packages/agent/src/approval-gate-port.ts` | `ApprovalRequest { tool: string; args: unknown }`; `ApprovalGate { requestApproval(batch: ApprovalRequest[], context: { threadId: string; turnId: string }, signal: AbortSignal): Promise<"approved" \| "denied"> }` — the `signal` param exists so an abort mid-wait resolves the batch as `"denied"` immediately instead of leaking until the 5-minute timeout; channel-agnostic; `packages/agent` never imports `@hermes/channels` |
| modify | `packages/agent/src/loop.ts` | before executing a response's tool calls, split them into gated (`requiresApproval: true`) and ungated; if any gated calls exist, `deps.approvalGate.requestApproval(gatedBatch, { threadId, turnId }, deps.signal)` runs **concurrently** with the ungated calls' execution (settled decision 16 — ungated calls are not blocked by the approval wait); once the gate resolves, gated calls either execute (approved) or each become a `"user did not approve"` tool result with `{ name: "tool.call", ..., approved: false }` (denied, timed out, or aborted — same code path, settled decision 7); all results (gated + ungated) are collected together before the next LLM call; `deps.approvalGate` becomes a required constructor dependency once any tool in `definition.tools` has `requiresApproval: true` — construction fails fast if a gated tool is configured with no gate supplied, rather than silently never asking |
| create | `packages/agent/src/index.ts` (extend) | export `ApprovalGate`, `ApprovalRequest` |
| create | `apps/hermes/src/agent/telegram-approval-gate.ts` | `createTelegramApprovalGate(channel: Channel, targetResolver: (threadId) => string /* chat target */, timeoutMs = 5 * 60 * 1000): ApprovalGate` — on `requestApproval(batch, context, signal)`, sends one message listing every gated call with Approve/Deny buttons carrying a generated approval id in `callbackData`; holds `Map<approvalId, { resolve, timer }>` in memory. **Resolution is one path, three triggers** — a tap (via boot's inbound-"callback" wiring), the `timeoutMs` window, or `signal` aborting, raced via `delay(timeoutMs, signal)` from `@hermes/core` against the tap's own promise. Whichever fires first synchronously deletes the map entry and clears the timer *before* any `await`, so the other two can never also resolve it; the tap and timeout paths then call `answerCallback`/`editMessage` to show "Approved"/"Denied"/"Expired" (best-effort, after the delete), while the abort path skips the edit (the process is shutting down). A `callback_query` referencing an approval id not in the map — because the process restarted, or because it was already resolved by a tap/timeout/abort — is the **same branch**: answer the callback with "this approval has expired, please ask again," never a hang, a throw, or a second execution |
| create | `apps/hermes/src/agent/tools/echo.ts` | `ToolSpec`: `name: "echo"`, `schema: z.object({ text: z.string() })`, `handler: async ({ text }) => text`, `requiresApproval: true` — the second ROADMAP-named throwaway tool |
| modify | `apps/hermes/src/agent/build-agent.ts` | `AgentDefinition.tools` gains `[getCurrentTimeTool, echoTool]`; construct and pass the `TelegramApprovalGate` into `createAgent`/`runTurn`'s deps |
| modify | `apps/hermes/src/boot.ts` | wire the new "callback" inbound kind from the channel's `subscribe` into the approval gate's resolver, alongside the existing message-dispatch wiring |
| modify | `apps/hermes/README.md` | document the approval flow: combined batch prompt, in-memory only (not persisted, restart drops pending approvals), 5-minute timeout resolves as denial |

**Steps:**

- [ ] `editMessage`'s job is specifically to make the buttons inert after one
      resolution — write a test proving a second callback against an
      already-resolved approval id (tap, timeout, or abort — same branch)
      gets the "expired" reply, never a second execution of the tool
- [ ] The combined-batch prompt: one message, one set of buttons, naming every
      gated call in the batch — not one message per gated call. Test this
      with a batch of two gated calls
- [ ] Timeout test uses fake timers, not a real 5-minute wait — assert the
      map entry is cleared and the tool results all read "user did not
      approve" after the timeout fires
- [ ] **Resolution races (two taps, or a timer racing a late tap) are
      resolved by "first resolution wins, everything after sees
      'expired'"** — this requires the map entry to be deleted
      *synchronously*, before any `await` (including the `editMessage` call
      that shows the resolved state), not just "eventually." State this
      explicitly and test it: a stale callback arriving immediately after the
      timer fires (before the timer's own `editMessage` has resolved) must
      still get the expiry reply, not a second resolution
- [ ] **Abort mid-wait**: a `signal` aborting while a batch is pending
      resolves every open approval as `"denied"` immediately — not after the
      5-minute timeout, and not left leaking past the 8s hard-exit budget.
      Test with fake timers: abort the signal without advancing time and
      assert `requestApproval` still settles
- [ ] Confirm ungated tool calls in the same batch as a gated one actually
      execute without waiting on the approval gate's promise — test this
      with a fake `ApprovalGate` whose promise never resolves during the
      test and assert the ungated call's result is still collected
- [ ] `deps.approvalGate` required-when-any-tool-is-gated: write the
      fail-fast construction test (a `definition` with an `echo`-like gated
      tool and no `approvalGate` supplied throws at construction, not at the
      first approval attempt)

**Tests:**

| Action | File | What it covers |
|---|---|---|
| modify | `packages/agent/src/__tests__/loop.test.ts` | a gated tool call, fake `ApprovalGate` resolving `"approved"` → handler runs, `tool.call` has `approved: true`; resolving `"denied"` → handler never runs, tool result is "user did not approve," `tool.call` has `approved: false`, loop continues to let the model respond; a batch with one gated + one ungated call: the ungated call's result is present even while the gate promise is still pending; constructing a definition with a gated tool and no `approvalGate` throws synchronously |
| create | `apps/hermes/src/agent/__tests__/telegram-approval-gate.test.ts` | sends the combined prompt with buttons for a multi-call batch (fake `Channel`); resolves `"approved"`/`"denied"` on a matching callback and edits the message; a callback for an approval id not in the map — unknown, already-resolved, or post-restart, all one code path — answers with the expiry message and never resolves or executes anything twice; fake-timer timeout resolves `"denied"`, edits the message, clears state; a stale callback arriving immediately after the timer fires still gets the expiry reply (proves the timer's map deletion happens synchronously, before its own `editMessage`); an aborted `signal` while a batch is pending resolves it `"denied"` immediately without advancing fake timers |
| create | `apps/hermes/src/agent/tools/__tests__/echo.test.ts` | handler returns its input `text` unchanged |
| modify | `packages/channels/src/telegram/__tests__/*.test.ts` | `sendMessage` with buttons includes the right `reply_markup`; `answerCallbackQuery`/`editMessageText` call the right Telegram endpoints; `allowedUpdates` includes `callback_query`; a `callback_query` update normalizes into the new inbound "callback" kind |

**Verification:**

- [ ] `pnpm -r test` green
- [ ] `pnpm -r typecheck` green
- [ ] Manual: ask the bot to echo something → one message with Approve/Deny
      buttons naming the call appears; tap Deny → the message updates to a
      resolved state, the bot's next reply shows it did not run `echo`, and
      `psql` shows `approved = false`
- [ ] Manual: ask again, tap Approve → `echo` runs, the reply contains the
      echoed text, `psql` shows `approved = true`
- [ ] Manual: ask a third time, tap nothing for 5 minutes → the prompt
      resolves to an expired/denied state on its own, and the bot's reply
      reflects non-approval
- [ ] Manual: tap an already-resolved prompt's button again → no second
      execution, a "this approval has expired" (or equivalent) callback answer

**Phase review:**

- [ ] All Steps and Verification checkboxes above ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block as the final message of this turn
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent has verified this phase
- [ ] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [ ] Tests for this phase written and passing
- [ ] Documentation updated (see Documentation section)
- [ ] Orchestrator (user) has verified and approved this phase
- [ ] Changes committed: `feat: approval gate with Telegram inline keyboards, echo tool`
- [ ] Phase marked complete

---

### Phase 4: Final Verification

**Mode:** hil

**Type:** mixed

**Overall success criteria:**

- A real, multi-turn Telegram conversation shows genuine memory across
  messages, survives a container restart, and `/stats`' cache-hit rate reads
  **above `0.0%`** — the number `02-telemetry` shipped correct-but-idle now
  actually moves, because the system prompt + tool definitions are byte-stable
  across calls and the growing history gives the provider a real shared
  prefix to cache.
- `get_current_time` and `echo` are both real, callable tools;
  `/stats`' top-tools section shows both once exercised.
- `echo`'s approval gate works end to end: Approve runs it, Deny blocks it and
  the model is told so, an unanswered prompt times out as a denial after 5
  minutes, and a resolved prompt's buttons are inert against a second tap.
- A batch of two gated calls in one model turn produces exactly one combined
  approval prompt.
- `packages/agent` depends only on `@hermes/core`, `@hermes/llm`, `zod` —
  never `@hermes/store` or any `apps/hermes` feature module — confirmed by
  inspection, not assumption.
- The abort signal genuinely interrupts the loop mid-turn: a shutdown issued
  while a turn is between iterations does not hang past the existing 8s
  hard-exit budget, and does not leave a half-persisted thread.
- No CLAUDE.md invariant is violated: `packages/agent`'s functions stay near
  the ~30-line guidance (`loop.ts` in particular, given how much this PRD adds
  to it — re-check it explicitly), no dead code, comments explain *why* not
  *what*.
- `cost_usd` vs `total_cost_usd` is never confused in a live query: a `turn`
  row's `total_cost_usd` matches the sum of its constituent `llm.call` rows'
  `cost_usd` for the same `turn_id`.

**Steps:**

- [ ] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [ ] Reviewer handoff prompt emitted in a fenced code block, scoped to end-to-end review of Phases 1–3 together
- [ ] Orchestrator cleared context (`/clear`) and pasted the handoff prompt into a fresh session
- [ ] Code-reviewer agent reviews the entire change end-to-end
- [ ] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [ ] All tests pass: `pnpm test` (default, hermetic), `pnpm test:db` (gated
      on `TEST_DATABASE_URL`)
- [ ] No CLAUDE.md invariants violated
- [ ] Feature tested manually: golden path (multi-turn memory survives
      restart, cache-hit rate moves, both tools callable, approval gate
      approves/denies/times out correctly), plus edge cases (unknown tool
      name from a model hallucination, invalid tool args, two gated calls in
      one batch, a shutdown mid-turn)
- [ ] Overall success criteria met
- [ ] `sync-knowledge` run to close out `.ai/` per the Knowledge Base Impact
      table below
- [ ] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| `TurnOutcome` union, nullable `threadId`/`turnId` still nullable on the type but always real in practice now | `packages/core/README.md` |
| Required `threadId`/`turnId` on `CompletionRequest`, `costUsd` on `CompletionResult` | `packages/llm/README.md` |
| `threads` table shape, one row per `(channel, chat_id)`, full untrimmed history, no archival policy yet | `packages/store/README.md` |
| `total_cost_usd` vs `cost_usd` split on `telemetry_events` | `packages/store/README.md` |
| Agent loop shape, byte-stable prefix contract, chars/4 trim boundaries, required `AbortSignal`, D4 seam scope | `packages/agent/README.md` |
| Tool registry, zod validation + two-strikes per-call retry counter, per-tool-call timeout, parallel execution, `tool.call` emission | `packages/agent/README.md` |
| Approval gate: combined batch prompt, in-memory/not-persisted, 5-minute timeout-as-denial | `packages/agent/README.md`, `apps/hermes/README.md` |
| Completion path now runs through the agent loop; boot wiring for `ThreadRepo`/`Agent`/`TelegramApprovalGate` | `apps/hermes/README.md` |
| Telegram inline-keyboard support: `editMessage`, `answerCallback`, `callback_query` inbound kind | `packages/channels/README.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | new `packages/agent` row; retire the "roadmap packages not yet created" line for `agent`; telemetry cross-cutting row stops saying `tool.call`/`turn` have no producer |
| `architecture.md` | update | dependency diagram gains `agent → core`, `agent → llm`, plus its injected `ThreadRepo`/`ApprovalGate` ports; replace the data-flow line "One `complete()` per message: no tool loop, no history persistence yet — that's `packages/agent`" with the real loop description; boot/shutdown notes gain the agent's required `AbortSignal` dependency |
| `decisions/telemetry-event-schema.md` | update | close **both** open items this doc still carries: (1) the `cost_usd`/`total_cost_usd` split (settled decision 1 — `turn` rows now write `total_cost_usd` and leave `cost_usd` `NULL`); (2) the `maxBufferSize`-byte-cap item, closed by declining — this PRD's shipped `tool.call` shape (`{ name, threadId, turnId, tool, durationMs, approved, error? }`) never carries the tool's actual result/payload, only a 500-char-truncated error, so the "unbounded tool result" concern the open item named never materializes; state this explicitly rather than leaving the item to be silently forgotten |
| `decisions/agent-loop-design.md` | create | bounded 8-iteration loop, the two-strikes per-call retry counter interpretation of "one retry" (first failure corrective, second failure terminal, keyed per tool name per turn — never a stable call id, since providers issue a fresh one each iteration), the per-tool-call handler timeout, how tool failures (unknown name, invalid args, handler throw, handler timeout) all feed back rather than abort a turn, why `TurnOutcome` excludes approval-denial and validation-failure |
| `decisions/approval-gate-design.md` | create | inline-keyboard mechanism, in-memory-only/not-persisted (and why — restart-drops-pending is accepted), combined single-batch-prompt (the user's override of per-call), 5-minute timeout-as-denial, resolution-is-one-path (tap/timer/abort all synchronously clear the same map entry before any async work, so none can double-resolve), abort-resolves-pending-approvals-immediately (not left to leak until the timeout) |
| `decisions/agent-multi-agent-seam.md` | create | what D4 reserves (`AgentDefinition` as a config object) vs. what it deliberately does not build (agent id columns, a manifest loader, more than one hardcoded list entry) |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | thread upsert idempotency, message append | `packages/store/src/__tests__/thread-repo.test.ts` |
| Phase 1 | byte-stable prefix assembly (empty tools) | `packages/agent/src/__tests__/prompt.test.ts` |
| Phase 1 | chars/4 drop-oldest trim, current-message protection | `packages/agent/src/__tests__/context-trim.test.ts` |
| Phase 1 | single-call loop shape: success, abort, provider failure, `turn` event emission | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 1 | `threadId`/`turnId` stamped onto `llm.call`; `costUsd` on the result | `packages/llm/src/adapter/__tests__/openai-compatible*.test.ts` |
| Phase 1 | `buildAgent`/`buildThreadRepo` wiring pin | `apps/hermes/src/agent/__tests__/build-agent.test.ts` |
| Phase 1 | `replyWithCompletion` calls the agent, not the provider directly | `apps/hermes/src/handlers/__tests__/complete.test.ts` |
| Phase 2 | tool call execution, unknown-tool/invalid-args feedback, parallel execution (deadlock-detecting), max-iteration cap | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 2 | `get_current_time` handler | `apps/hermes/src/agent/tools/__tests__/get-current-time.test.ts` |
| Phase 3 | approval gate integration into the loop: approve, deny, concurrent ungated execution, fail-fast construction | `packages/agent/src/__tests__/loop.test.ts` |
| Phase 3 | Telegram approval gate: combined batch prompt, resolution, expiry, idempotent second tap, timeout | `apps/hermes/src/agent/__tests__/telegram-approval-gate.test.ts` |
| Phase 3 | `echo` handler | `apps/hermes/src/agent/tools/__tests__/echo.test.ts` |
| Phase 3 | Telegram client button support, callback inbound normalization | `packages/channels/src/telegram/__tests__/*.test.ts` |

## Human Summary

This plan turns Hermes from a bot with no memory into one that actually holds
a conversation, and gives it two harmless tools to prove the mechanism works
before anything real gets plugged into it later. It starts by replacing the
single, stateless LLM call every message triggered until now with a loop that
remembers — every chat gets its own row of full conversation history in
Postgres, read back on every message and surviving a restart, with a crude but
honest trim (drop the oldest messages once a rough token budget is exceeded)
so a long conversation doesn't grow the request without bound. That alone is
also what makes `/stats`' cache-hit number — shipped correct but stuck at zero
because there was never enough of a shared prompt to cache — finally move,
because now the system prompt and conversation history form a real,
byte-for-byte-stable prefix across calls. Once that foundation is proven, the
plan gives the model actual tools to call: a registry the loop derives JSON
schemas from, arguments validated with zod and given exactly one chance to be
corrected if the model gets them wrong — a second bad attempt at the same
tool gets a terminal error instead of a third try, so one confused tool call
costs at most two paid calls, not eight — multiple tool calls in one turn
running at the same time instead of one after another (each with its own
timeout so a stuck handler can't stall the whole turn), and every call and
turn landing as a telemetry event so `/stats`' tool rollup — also shipped
empty, waiting — starts showing real data. The last piece is an approval gate:
some tools (today, only a harmless `echo`) need a human to say yes first, and
that "yes" arrives as actual Telegram buttons on the message, held in memory
only — a restart drops anything still waiting rather than pretending it
survived — with an unanswered prompt treated as a "no" after five minutes so
the conversation is never stuck waiting forever. Two tools ship, both
throwaways by design: enough to prove the registry, the validation, the
parallel execution, and the approval flow actually work, without pretending
this PRD is where Hermes gets its first real capability. That's deliberately
next.
