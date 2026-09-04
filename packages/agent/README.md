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
`ctx` with `channel`/`channelUserId` — see below. `05-google-sheets` Phase 4
widens `ctx` again with `turnId`, and adds `ToolSpec.timeoutMs?: number` so a
tool making a real outbound HTTP call (the Sheets tools) can override the
default 10s handler timeout — see below.

## Port contract

`src/types.ts`:

- `Message` — reused from `@hermes/core`, never redefined.
- `ToolSpec { name, description, schema: z.ZodTypeAny, handler, requiresApproval, timeoutMs? }`
  — a tool made available to the model. `handler(args: unknown, { signal,
  channel, channelUserId, turnId }): Promise<unknown>` receives its
  `safeParse`d args and the turn's `AbortSignal`, plus `channel`/
  `channelUserId` — identifying who is asking, threaded from `runTurn`'s own
  parameters (the latter itself threaded from `Agent.handleMessage`,
  `04-google-auth`'s Phase 3) — and `turnId` (`05-google-sheets` Phase 4),
  the same id `runTurn` already generates and sends the provider as
  `CompletionRequest.turnId`. `whoami`
  (`apps/hermes/src/agent/tools/whoami.ts`) is the first tool that reads
  `channel`/`channelUserId` — a Google-identity lookup scoped to the asking
  chat, with no hardcoded channel constant. `sheets_write` (Phase 5) is the
  first to read `turnId`, as part of its write-dedupe key. **Each of these
  was a required-field widening of the contract, not an additive one**:
  every existing `ctx` literal, including in tests that invoke a handler
  directly, had to gain the new field. No mutable `register()`: tools are
  supplied once, at `AgentDefinition` construction, because
  registration-order nondeterminism would threaten the byte-stable prefix
  invariant #6 depends on. The registry itself (a `Map<string, ToolSpec>`
  keyed by name) is built fresh inside `loop.ts`'s `converse()` on every
  `runTurn` call — it isn't a standalone module, and doesn't need to be with
  a handful of tools.
  `timeoutMs` (`05-google-sheets` Phase 4) overrides `loop.ts`'s default
  10s handler timeout (`TOOL_HANDLER_TIMEOUT_MS`) for one tool — a real
  outbound HTTP call (`sheets_inspect`/`sheets_read`, each set to 30s) can
  legitimately take longer than a local computation once its own internal
  retries are counted. Every tool that leaves it `undefined` keeps the 10s
  default unchanged — this is additive, not a widening: no existing `ToolSpec`
  literal needed a change. The trade-off is explicit UX cost, not free: a
  turn can stall up to the configured timeout with the user watching a
  silent chat. ROADMAP invariant 9 ("every loop bounded") still holds — the
  bound is explicit and finite, just larger than the default for the tools
  that opt in.
- `AgentDefinition { name, model, systemPrompt, tools, channels }` — the one
  configuration object per agent, and the entire D4 multi-agent seam
  (settled decision 10): reserved, not built. `apps/hermes` passes one
  hardcoded `AgentDefinition[]` with a single entry at boot
  (`src/agent/build-agent.ts`). Nothing here makes a second agent more than a
  second list entry away, but nothing here adds that entry either.

`05-google-sheets` Phase 2 adds `apps/hermes/src/agent/with-required-scopes.ts`'s
`withRequiredScopes` decorator, which wraps a tool's `ToolSpec.handler`
behind a connected-account + required-scope check. It does **not** widen
`ToolSpec.handler`'s `ctx` itself — this package's `ToolContext` (`{ signal,
channel, channelUserId }`) is unchanged, and `packages/agent` still never
imports `@hermes/google-auth` or `@hermes/store`. Instead
`with-required-scopes.ts` defines its own `apps/hermes`-local
`ScopedToolContext = ToolContext & { googleAccount }` and a parallel
`ScopedToolSpec` whose `handler` expects that richer ctx; the decorator
fetches the account once, and — only on success — calls the wrapped
`ScopedToolSpec.handler` with the extended ctx, never assigning it to a bare
`ToolSpec.handler` slot (TS's contravariant parameter checking would
correctly reject that). A tool built this way (`whoami`, and the Sheets
tools Phase 4/5 add) never calls `googleAccountRepo.getAccount` a second
time inside its own handler — one DB read per tool invocation, not two.
`with-required-scopes.ts`'s decorator needs **no code change** for either of
this package's `ctx` widenings: `ScopedToolContext`/`ToolContext` there are
derived types (`Parameters<ToolSpec["handler"]>[1]`), so `turnId` reaching
`ToolSpec.handler` automatically reaches the decorator's ctx too, and it
passes `ctx` through to the wrapped handler unchanged either way. The
`ApprovalGate` (`requestApproval(batch, { threadId, turnId }, signal)`)
already received `turnId` as its own explicit parameter, sourced the same
place `ctx.turnId` now is, not through `ctx` — also unaffected.

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
   throws `MaxIterationsReachedError` — exported from `@hermes/agent`
   (`07-one-paid-turn-one-outcome` Phase 2, so `apps/hermes`'s completion
   handler can `instanceof`-check it and reply with distinct Spanish copy
   instead of the generic failure text) — carrying the real accumulated cost
   and iteration count from the calls that did happen as
   `totalCostUsd`/`iterations` constructor fields, in that order.
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
4. On successful validation, `spec.handler(args, { signal, channel,
   channelUserId, turnId })` runs inside a `Promise.race` against
   `delay(spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS, ...)` (`delay` reused
   from `@hermes/core`) — a handler that never resolves feeds back `"tool
   timed out after <ms>ms"` instead of stalling the turn. `deps.signal.aborted`
   is checked immediately before invocation. A handler that **throws** feeds
   back the thrown error's message — like every other failure mode here,
   this never aborts the turn. The race's `delay` runs against `deps.signal`
   composed (`AbortSignal.any`) with a controller `invokeToolHandler` owns and
   aborts once the race settles either way: this cancels the timer
   immediately when the handler wins instead of leaking it for up to the
   effective timeout, and lets a turn-level shutdown that lands mid-handler
   resolve the race early too — reported back as `"tool aborted: agent turn
   was shut down before the handler finished"`, distinct from a genuine
   timeout (`deps.signal.aborted` disambiguates the two once the race
   settles).
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

## The `prepare` hook (`06-legible-approvals-bounded-reads` Phase 3)

`ToolSpec` is generic — `ToolSpec<P = void>` — over the shape of a `plan` a
tool's optional `prepare?(args: unknown, ctx: ToolContext): Promise<
ToolPreparation<P>>` hook resolves. `handler`'s `ctx` always carries `plan:
P` (never optional — a prepare-less tool's `plan` is typed `void` and always
`undefined` at runtime, so "no plan" is a value, not an absent property).
`ToolPreparation<P>` (`src/types.ts`) is a discriminated union: `{ok: false,
result: unknown}` refuses the call outright — `result` becomes the call's
tool-result content, the same as if the handler itself had returned it — or
`{ok: true, plan: P, summary: ApprovalSummary}`, which threads `plan` onto
`ctx.plan` for the eventual `handler` call and hands the approval gate
`summary` to render.

`ApprovalSummary` (`src/approval-gate-port.ts`) is the small, concrete,
tool-agnostic display vocabulary a `prepare` populates in place of raw JSON:
`{ action: string; target?: string; items?: string[]; itemsTotal?: number;
effects: string[] }` — `action` is always the first line (a yes/no
question), `target` an optional second line naming what it acts on,
`items`/`itemsTotal` an optional preview list with a count line when
truncated, `effects` trailing sentences describing consequences. Deliberately
concrete, not `unknown`: the gate can render any tool's summary with zero
per-tool branching, and TypeScript rejects a `prepare` that omits
`action`/`effects`.

`prepare` only ever runs on the **gated** path, before the approval prompt is
built — never on the ungated path, even for a tool that declares one (no
ungated tool does today; `loop.ts`'s `resolveToolCall` documents this as
intentional, not an oversight). `loop.ts`'s `prepareGatedCall` runs it after
`safeParse`, raced against the same `spec.timeoutMs ?? TOOL_HANDLER_TIMEOUT_MS`
bound the handler itself uses (`delay`, the same pattern `invokeToolHandler`
uses). A throw, a timeout, an abort mid-flight, and a `{ok: false}` result are
all "refused" the same way: no prompt is ever sent for that call, and it
resolves immediately as a denial-shaped tool result — `{ok: false, reason:
"prepare_failed"}` for a throw/timeout/abort, or the tool's own `result` for
an explicit `{ok: false}` (e.g. `sheets_write`'s `unknown_sheet`). A batch
with two or more gated calls is split by `buildApprovalBatch`: refused calls
resolve immediately (`approved: false` on their `tool.call` event, diagnostic
detail preserved via `error`, mirroring every other failure path in this
file), and only the survivors are sent to `requestApproval` — skipped
entirely when nothing survives. The batch entry a survivor contributes always
carries `toolCall.arguments` — the model's **raw**, unparsed args, never the
`safeParse`d/defaulted form `prepare`/`handler` receive — so a zod-applied
default can never silently change what a human is shown or what `tool.call`
logs.

`sheets_write` (`@hermes/google-sheets`) is the one tool in this codebase
that declares `prepare`; see that package's README for how it splits slug
resolution (in `prepare`) from the write itself (in `handler`, reading
`ctx.plan`).

## Approval gate

`src/approval-gate-port.ts` exports `ApprovalRequest { tool, args, plan?,
summary? }` (`args` is the model's *raw* requested arguments, shown to the
human as-is — not the `schema.safeParse`d result; `plan`/`summary` are
additive, populated only for a call whose `prepare` resolved one — see "The
`prepare` hook" above) and the injected `ApprovalGate` port:
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
- **Validation and `prepare` run before the prompt, not after the decision**
  (`06-legible-approvals-bounded-reads` Phase 3 — the one place the gated
  path's ordering differs from the ungated one). `prepareGatedCall`
  `safeParse`s each call and runs its `prepare`, and `buildApprovalBatch`
  splits the outcomes: refused calls resolve immediately with no prompt and
  no `approvalWaitMs`, and only the survivors reach `requestApproval` —
  skipped entirely when nothing survives. Both paths share
  `parseToolCallArgs`, so a gated and an ungated validation failure count
  against the same per-tool-name budget and produce byte-identical content.
- **Approved**: each surviving call's handler runs with the `parsedArgs` and
  `plan` its preparation already resolved (`runReadyGatedCalls`) — never
  re-parsed, never re-`prepare`d, since the batch already committed to those
  exact values when it asked the human. Approval only gates *whether* a call
  runs, never how its args were validated or prepared.
- **Denied, timed out, or aborted mid-wait are the same code path** (settled
  decision 7): every *surviving* call in the batch becomes a `"user did not approve"`
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
"Aprobar"/"Rechazar" buttons (Spanish — `06-legible-approvals-bounded-reads`
Phase 3; `callbackData` still encodes lowercase `"approve"`/`"deny"` action
tokens, unaffected by the label translation) per batch, held in an in-memory
`Map<approvalId, ...>` — **not persisted** (settled decision 6 — a restart
drops any pending approval). Resolution — a tap, the 5-minute timeout, or the
turn's `AbortSignal` firing — is one code path: whichever fires first
synchronously deletes the map entry *before* any `await` (including the
`editMessage` that shows the resolved state), so the other two triggers can
never also resolve it, and a `callback_query` referencing an id that's
unknown, already resolved, or gone because the process restarted is the same
branch: answer with "this approval has expired, please ask again," never a
hang or a second execution. Right before sending a batch's prompt, it logs
`logger.debug("approval prompt prepared", {tool, args, plan})` for each ready
call — raw args plus the resolved `plan` (never `summary`, which carries less
detail) — at debug level only, off by default in production.

The prompt body itself is rendered by `apps/hermes/src/agent/
approval-prompt-renderer.ts`'s `formatBatchPrompt`/`formatResolvedText`, kept
deterministic and tool-agnostic on purpose (see that file's own doc and
`apps/hermes/README.md`): rendering is **per call**, not per batch. A call
that resolved a usable `ApprovalSummary` renders the headerless,
legible-Spanish block (`action`/`target`, indented `items` with a count line,
then `effects`); a call without one — prepare-less, or a summary whose
`action` came back empty — renders that call's raw-JSON line instead, so a
mixed batch shows one block per call rather than dragging every call back to
raw JSON. The pre-plan whole-batch format ("The model wants to run:" plus one
`- tool(args)` line per call, minus its old trailing "Approve or deny?"
question) survives byte-identical for exactly one case: **every** call in the
batch falling back. See `apps/hermes/README.md` for the Telegram-specific
mechanics.

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
`ToolSpec`, `ToolContext`, `ToolPreparation`, `ApprovalGate`,
`ApprovalRequest`, `ApprovalSummary`, `ThreadRepo`, `Thread`, `Message`, and
(`07-one-paid-turn-one-outcome` Phase 2) `MaxIterationsReachedError` — the
one concrete class export alongside the port types above, so a consumer can
`instanceof`-check it without `packages/agent` also exposing `loop.ts`'s
internals. Nothing else is public; `loop.ts`, `prompt.ts`, and
`context-trim.ts` are internal.

## Dependencies

`@hermes/core`, `@hermes/llm`, `zod` — already a workspace dependency
elsewhere (`@hermes/config`); no new package. Deliberately not `@hermes/store`
(persistence arrives as an injected port, see above) or any `apps/hermes`
feature module (that boundary *is* the D4 seam).
