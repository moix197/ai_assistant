# @hermes/agent

The bounded agentic loop: turns a stateless single-shot LLM reply into a real
multi-turn conversation with restart-safe history. Phase 1 of
`plans/03-agent-core.md` shipped the loop's simplest shape — load thread, trim
history, call the model once, persist, reply — with no tools. Phase 2 added
the tool registry and a real multi-iteration loop: zod validation, a
two-strikes per-tool-call retry counter, a per-tool-call handler timeout, and
concurrent execution of every tool call in one model response. Phase 3
(`03-agent-core`) added the approval gate: some tools require a human's
yes/no before they run. `04-google-auth` Phase 3 widened `ToolSpec.handler`'s
`ctx` with `channel`/`channelUserId` — see below.

## Port contract

`src/types.ts`:

- `Message` — reused from `@hermes/core`, never redefined.
- `ToolSpec { name, description, schema: z.ZodTypeAny, handler, requiresApproval }`
  — a tool made available to the model. `handler(args: unknown, { signal,
  channel, channelUserId }): Promise<unknown>` receives its `safeParse`d
  args and the turn's `AbortSignal`, plus `channel`/`channelUserId` —
  identifying who is asking, threaded from `runTurn`'s own parameters (the
  latter itself threaded from `Agent.handleMessage`, `04-google-auth`'s Phase
  3). `whoami` (`apps/hermes/src/agent/tools/whoami.ts`) is the first tool
  that reads these — a Google-identity lookup scoped to the asking chat, with
  no hardcoded channel constant. **This was a required-field widening of the
  contract, not an additive one**: every existing `ctx` literal, including in
  tests that invoke a handler directly, had to gain both fields. No mutable
  `register()`: tools are supplied once, at `AgentDefinition` construction,
  because registration-order nondeterminism would threaten the byte-stable
  prefix invariant #6 depends on. The registry itself (a `Map<string,
  ToolSpec>` keyed by name) is built fresh inside `loop.ts`'s `converse()` on
  every `runTurn` call — it isn't a standalone module, and doesn't need to be
  with a handful of tools.
- `AgentDefinition { name, model, systemPrompt, tools, channels }` — the one
  configuration object per agent, and the entire D4 multi-agent seam
  (settled decision 10): reserved, not built. `apps/hermes` passes one
  hardcoded `AgentDefinition[]` with a single entry at boot
  (`src/agent/build-agent.ts`). Nothing here makes a second agent more than a
  second list entry away, but nothing here adds that entry either.

`packages/agent` depends only on `@hermes/core`, `@hermes/llm` (for
`LlmProvider`/`CompletionRequest`/`ToolDefinition`/`MAX_TOKENS_PER_TURN`/
`LlmAbortedError`), and `zod` — **never** `@hermes/store` or any
`apps/hermes` feature module. This *is* the D4 seam: a tool with a real side
effect is defined in `apps/hermes` and passed in already-built, not imported
here.

## Byte-stable prefix

`src/prompt.ts`'s `assemblePrefix(definition)` returns `{ system, toolDefs }`:
`system` is `definition.systemPrompt` verbatim — static, zero dynamic
content, no dates, no user names (current time is a *tool*, Phase 2, never a
prompt line). `toolDefs` derives each tool's JSON Schema via `zod/v4`'s
`z.toJSONSchema`, with `definition.tools` sorted by name first and each
schema's own keys emitted in sorted order (`sortKeysDeep`). Two independent
calls with the same `definition` produce byte-identical output — proven with
`definition.tools = []` in Phase 1, and now (this phase) with a non-empty
`definition.tools` too (`__tests__/prompt.test.ts`): `assemblePrefix` itself
is unmodified since Phase 1, reused exactly as it shipped. This is what lets
`/stats`' cache-hit rate (`02-telemetry`) actually move: a provider can only
cache a prefix that never drifts by even one byte between calls. `loop.ts`
sends `tools: toolDefs` on the request only when `definition.tools.length >
0`; otherwise `tools: undefined`, exactly as Phase 1 shipped it.

`packages/agent` uses `zod/v4` (the subpath the installed `zod@3.25.76`
ships, not the top-level `zod` classic export) specifically because
`z.toJSONSchema` lives there — no new dependency, see
`plans/03-agent-core.md`'s Dependencies & Risks.

## Context trim

`src/context-trim.ts`'s `trimHistory(messages, budgetChars)` implements the
"crude" chars/4 token estimate (settled decision 9, ROADMAP §2c) — a
tokenizer-accurate budget is Phase 8, explicitly out of scope here.
`HISTORY_BUDGET_CHARS` is a package-internal constant, not env-configurable —
the same posture `@hermes/telemetry`'s `maxBufferSize` has.

Trimming is **group-aware**: a `role: "assistant"` message carrying
`toolCalls` and every immediately following `role: "tool"` message answering
it are treated as one atomic unit for trim purposes, dropped together and
never split — orphaning a `role: "tool"` message from the assistant
`toolCalls` message it answers would make it meaningless on replay (every
OpenAI-compatible provider rejects it). Every other message is its own
single-message group. Groups are dropped oldest-first, exactly like the
message-level trim it replaced, just at group granularity; at least one
group always survives, even if it alone exceeds the whole budget.

Each message's estimated size (`estimateSize`) is `content.length / 4` plus,
for an assistant message carrying `toolCalls`, its requested arguments'
serialized length — an assistant tool-call message's own `content` is often
empty, so without this a tool-heavy turn could stay invisible to
`HISTORY_BUDGET_CHARS` regardless of how much argument payload it actually
carries.

This function **never touches the prefix** and **never sees the turn's newest
user message** — `loop.ts` calls it only on stored history, then appends the
new user message afterward, so it can never be dropped even if it alone
exceeds the budget. Trimming only ever affects what is *sent* to the model on
a given call; the full, untrimmed history is always what gets persisted.

## The loop

`src/loop.ts`'s `runTurn(definition, deps, channel, chatId, userText)`:

1. Load or create the thread via the injected `ThreadRepo`
   (`getOrCreateThread`).
2. Run the tool-execution loop (`converse`, internal): assemble the prefix
   (`assemblePrefix`) and trim stored history (`trimHistory`,
   `HISTORY_BUDGET_CHARS`) once, then call `llmProvider.complete(...)` up to
   `MAX_ITERATIONS` (8) times. Before **every** iteration, check
   `deps.signal.aborted` and throw `LlmAbortedError` (reused from
   `@hermes/llm`) if it's already set — `deps.signal` is a required
   constructor dependency, not optional: a deliberate reaction to
   `02-telemetry` Phase 6's own "mechanism built but never wired" bug, where
   the boot `AbortController`'s signal had been wired into the LLM adapter
   but never into the Telegram poller.
3. If a response's `toolCalls` is empty, the loop is done: that response's
   `text` is the turn's reply.
4. Otherwise, the response's own assistant tool-call request is appended to
   the conversation first — `{ role: "assistant", content: result.text,
   toolCalls: result.toolCalls }` — then every entry in `toolCalls` is
   resolved concurrently (see "Tool execution" below) into a `role: "tool"`
   result message, all of which are appended after it, before the next
   iteration. This order is required, not cosmetic: every OpenAI-compatible
   provider 400s a `role: "tool"` message that isn't preceded by the
   assistant message requesting it (`@hermes/llm`'s adapter maps
   `Message.toolCalls`/`toolCallId` to the wire's `tool_calls`/`tool_call_id`
   keys — see that package's README).
5. Reaching `MAX_ITERATIONS` without ever getting an empty `toolCalls`
   throws an internal `MaxIterationsReachedError` carrying the real
   accumulated `costUsd` and iteration count from the calls that did happen.
6. On success: persist the **real conversation tail** this turn produced in
   **one** `appendMessages` call — the seed user message plus every
   assistant/tool message `converse()`'s internal `conversation` array
   accumulated, in wire order, ending with the final assistant reply. This is
   a slice of that one array, not a re-derived two-message shape: a
   tool-calling turn persists the assistant's `tool_calls` message and the
   matching `role: "tool"` result(s) it produced, not just a flattened
   user/assistant pair — `psql`ing `threads.messages` after such a turn shows
   the real shape. Then emit a `turn` telemetry event (`iterations` =
   however many calls it took, `outcome: "completed"`, `totalCostUsd` = the
   sum of every iteration's `costUsd`), and return the reply text.
7. On any thrown error: emit a `turn` event and **rethrow the original error
   unchanged** — no new error-handling branch, so the existing completion
   handler's generic-failure reply still applies.
   `outcome: "max_iterations"` (`MaxIterationsReachedError`, `totalCostUsd`/
   `iterations` from the error) and the generic `outcome: "error"`/`"aborted"`
   paths both report the real accumulated `totalCostUsd`/`iterations` as of
   the failing call — the latter via a `TurnProgress` accumulator threaded
   into `converse()`, updated after every completed iteration, since a
   provider failure (including `UnpricedModelError`, which gets no other
   special-casing) can land several billed iterations into a turn, not just
   the first.

## Tool execution

For each `toolCall` in a response's `toolCalls`, `loop.ts` (`resolveToolCall`):

1. Looks up a `ToolSpec` by name in the registry (a `Map` built once per
   `runTurn` call from `definition.tools`, keyed by name — not a standalone
   module, and not cached across turns).
2. An **unknown tool name** feeds back `"unknown tool: <name>"` — never
   throws, the turn continues (settled decision 15's error-recovery shape,
   applied uniformly to every tool failure mode below).
3. A known tool's `arguments` are `schema.safeParse`d. On failure, a
   `Map<toolName, number>` scoped to this turn tracks a **two-strikes retry
   counter**, keyed by tool name (never a stable call id — providers issue a
   fresh one every iteration): the first failure for a given tool name feeds
   back the raw zod error message (the model's one corrective attempt); the
   second (and every failure after) feeds back the terminal
   `"invalid arguments, giving up: <zod error>"` and that tool name gets no
   further corrective feedback for the rest of the turn. The counter is
   never decremented by an intervening success, and is isolated per tool
   name — a different tool's first failure in the same turn still gets its
   own corrective round-trip.
4. On successful validation, `spec.handler(args, { signal: deps.signal })`
   runs inside a `Promise.race` against `delay(TOOL_HANDLER_TIMEOUT_MS, ...)`
   (`delay` reused from `@hermes/core`) — a handler that never resolves feeds
   back `"tool timed out after <ms>ms"` instead of stalling the turn.
   `deps.signal.aborted` is checked immediately before invocation. A handler
   that **throws** feeds back the thrown error's message — like every other
   failure mode here, this never aborts the turn. The race's `delay` runs
   against `deps.signal` composed (`AbortSignal.any`) with a controller
   `invokeTool` owns and aborts once the race settles either way: this
   cancels the timer immediately when the handler wins instead of leaking it
   for up to `TOOL_HANDLER_TIMEOUT_MS`, and lets a turn-level shutdown that
   lands mid-handler resolve the race early too — reported back as `"tool
   aborted: agent turn was shut down before the handler finished"`, distinct
   from a genuine timeout (`deps.signal.aborted` disambiguates the two once
   the race settles).
5. **Every tool call in one model response executes concurrently** via
   `Promise.all`/`.map()` — each call's synchronous work (registry lookup,
   `safeParse`, the abort check) runs before its first `await`, so there's no
   event-loop gap between calls for an abort to land "between" them.
6. Each call — regardless of outcome — emits its own `tool.call` telemetry
   event: `{ name: "tool.call", threadId, turnId, tool, durationMs, approved,
   approvalWaitMs?, error? }`. `error`, when present, is truncated to 500
   characters — the same bound `02-telemetry`'s settled decision 14 puts on
   `llm.call`'s `error`. `approved` is `true` for every ungated call; a
   gated call's `approved` reflects the approval gate's real decision (see
   below). `durationMs` is **handler execution time only** — it starts once
   validation has passed and the handler is actually invoked (or, for a
   gated call, once the approval gate has resolved), never before.
   `approvalWaitMs` is `undefined` on an ungated call and present (possibly
   `0`) on any call that went through the approval gate, measuring the time
   spent inside `requestApproval` itself — split out so a denied/timed-out
   gated call's multi-minute approval wait is no longer misattributed to
   `durationMs` (settled decision 12a; see the Approval gate section below).

`TOOL_HANDLER_TIMEOUT_MS` is a package-internal constant (not
env-configurable, same posture as `MAX_ITERATIONS`/`HISTORY_BUDGET_CHARS`),
independent of the turn-level iteration cap.

## Approval gate

`src/approval-gate-port.ts` exports `ApprovalRequest { tool, args }` (the
model's *raw* requested arguments, shown to the human as-is — not the
`schema.safeParse`d result) and the injected `ApprovalGate` port:
`requestApproval(batch, { threadId, turnId }, signal): Promise<"approved" |
"denied">`. Channel-agnostic — `packages/agent` never imports
`@hermes/channels`; the one real implementation
(`apps/hermes/src/agent/telegram-approval-gate.ts`) is Telegram-specific and
lives entirely in `apps/hermes`, matching the D4-seam boundary rule.

Before executing a response's tool calls, `loop.ts` (`executeToolCalls`)
splits them into gated (`requiresApproval: true`) and ungated:

- **Ungated calls run immediately**, exactly as Phase 2 shipped them — the
  approval wait for any gated calls in the same batch never blocks them
  (settled decision 16). This is proven with a fake `ApprovalGate` whose
  promise never resolves during the test and the ungated call's result still
  lands.
- **Gated calls in the same model response share one combined approval
  prompt** (settled decision 5 — the user's own override of a more granular
  per-call default): `runGatedToolCalls` builds one `ApprovalRequest[]` batch
  and calls `requestApproval` once for the whole batch, not once per call.
- **Approved**: every gated call in the batch falls through to the exact same
  validate-then-invoke path an ungated call takes (`runToolCalls`) — approval
  only gates *whether* a call runs, never how its args are validated or
  retried.
- **Denied, timed out, or aborted mid-wait are the same code path** (settled
  decision 7): every call in the batch becomes a `"user did not approve"`
  tool result, `approved: false` on its `tool.call` event, no handler ever
  runs, and the turn's retry counter is untouched. Its `durationMs` is
  near-zero (no handler ran) while `approvalWaitMs` carries the real time
  spent waiting on `requestApproval` — what `durationMs` used to
  misattribute before this split. The loop *continues* — an approval denial
  never ends a turn (`TurnOutcome` excludes it, settled decision 13) — so
  the model sees the denial and can respond to it.
- `RunTurnDeps.approvalGate` is optional in the type, but `runTurn` calls
  `assertApprovalGateConfigured` synchronously at the very top of the
  function, before any I/O: if any tool in `definition.tools` sets
  `requiresApproval: true` and no `approvalGate` was supplied, it throws
  immediately — fail-fast at construction, not silently never asking on the
  first gated call.

`apps/hermes/src/agent/telegram-approval-gate.ts`'s `createTelegramApprovalGate`
implements the port over Telegram inline keyboards: one message with
Approve/Deny buttons per batch, held in an in-memory `Map<approvalId, ...>` —
**not persisted** (settled decision 6 — a restart drops any pending
approval). Resolution — a tap, the 5-minute timeout, or the turn's
`AbortSignal` firing — is one code path: whichever fires first synchronously
deletes the map entry *before* any `await` (including the `editMessage` that
shows the resolved state), so the other two triggers can never also resolve
it, and a `callback_query` referencing an id that's unknown, already
resolved, or gone because the process restarted is the same branch: answer
with "this approval has expired, please ask again," never a hang or a second
execution. See `apps/hermes/README.md` for the Telegram-specific mechanics.

## Persistence port

`src/thread-repo-port.ts` exports `Thread { id, channel, chatId, messages }`
and `ThreadRepo { getOrCreateThread(channel, chatId), appendMessages(threadId,
messages) }` — an injected port, mirroring `packages/llm`'s
`LlmUsageRepo`/`BudgetUsageRepo`. `apps/hermes/src/store/build-thread-repo.ts`
wires this to `@hermes/store`'s `getOrCreateThread`/`appendMessages`. Full,
untrimmed history is always persisted — including the real assistant
`tool_calls`/`role: "tool"` shape a tool-calling turn produced, not a
flattened summary (see "The loop" above) — and the chars/4 group-aware trim
above only ever affects what is sent to the model on a given call. On read,
`@hermes/store`'s `getOrCreateThread` validates the stored `messages` jsonb
against `@hermes/core`'s `messageSchema` before returning it, so a
hand-corrupted row throws instead of being silently replayed to the
provider.

## Public API

`src/index.ts` exports `createAgent(definition, deps)` — a thin factory
wrapping `runTurn` and the injected deps into a `{ handleMessage(channel,
chatId, text): Promise<string> }` object — plus `AgentDefinition`,
`ToolSpec`, `ApprovalGate`, `ApprovalRequest`, `ThreadRepo`, `Thread`, and
`Message`. Nothing else is public; `loop.ts`, `prompt.ts`, and
`context-trim.ts` are internal.

## Dependencies

`@hermes/core`, `@hermes/llm`, `zod` — already a workspace dependency
elsewhere (`@hermes/config`); no new package. Deliberately not `@hermes/store`
(persistence arrives as an injected port, see above) or any `apps/hermes`
feature module (that boundary *is* the D4 seam).
