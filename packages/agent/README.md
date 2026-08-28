# @hermes/agent

The bounded agentic loop: turns a stateless single-shot LLM reply into a real
multi-turn conversation with restart-safe history. Phase 1 of
`plans/03-agent-core.md` shipped the loop's simplest shape — load thread, trim
history, call the model once, persist, reply — with no tools. Phase 2 (this
phase) adds the tool registry and a real multi-iteration loop: zod
validation, a two-strikes per-tool-call retry counter, a per-tool-call
handler timeout, and concurrent execution of every tool call in one model
response. Phase 3 adds the approval gate.

## Port contract

`src/types.ts`:

- `Message` — reused from `@hermes/core`, never redefined.
- `ToolSpec { name, description, schema: z.ZodTypeAny, handler, requiresApproval }`
  — a tool made available to the model. `handler(args: unknown, { signal }):
  Promise<unknown>` receives its `safeParse`d args and the turn's
  `AbortSignal`. No mutable `register()`: tools are supplied once, at
  `AgentDefinition` construction, because registration-order nondeterminism
  would threaten the byte-stable prefix invariant #6 depends on. The
  registry itself (a `Map<string, ToolSpec>` keyed by name) is built fresh
  inside `loop.ts`'s `converse()` on every `runTurn` call — it isn't a
  standalone module, and doesn't need to be with one or two tools.
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
tokenizer-accurate budget is Phase 8, explicitly out of scope here. Each
message's estimated size is `content.length / 4`; the oldest messages are
dropped first until the running total fits `budgetChars`. `HISTORY_BUDGET_CHARS`
is a package-internal constant, not env-configurable — the same posture
`@hermes/telemetry`'s `maxBufferSize` has.

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
6. On success: persist the user message and the assistant reply together in
   **one** `appendMessages` call, emit a `turn` telemetry event
   (`iterations` = however many calls it took, `outcome: "completed"`,
   `totalCostUsd` = the sum of every iteration's `costUsd`), and return the
   reply text.
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
   event: `{ name: "tool.call", threadId, turnId, tool, durationMs, approved:
   true, error? }`. `approved: true` unconditionally this phase, since no
   approval gate exists yet (Phase 3). `error`, when present, is truncated to
   500 characters — the same bound `02-telemetry`'s settled decision 14 puts
   on `llm.call`'s `error`.

`TOOL_HANDLER_TIMEOUT_MS` is a package-internal constant (not
env-configurable, same posture as `MAX_ITERATIONS`/`HISTORY_BUDGET_CHARS`),
independent of the turn-level iteration cap.

## Persistence port

`src/thread-repo-port.ts` exports `Thread { id, channel, chatId, messages }`
and `ThreadRepo { getOrCreateThread(channel, chatId), appendMessages(threadId,
messages) }` — an injected port, mirroring `packages/llm`'s
`LlmUsageRepo`/`BudgetUsageRepo`. `apps/hermes/src/store/build-thread-repo.ts`
wires this to `@hermes/store`'s `getOrCreateThread`/`appendMessages`. Full,
untrimmed history is always persisted; the chars/4 trim above only ever
affects what is sent to the model on a given call.

## Public API

`src/index.ts` exports `createAgent(definition, deps)` — a thin factory
wrapping `runTurn` and the injected deps into a `{ handleMessage(channel,
chatId, text): Promise<string> }` object — plus `AgentDefinition`,
`ToolSpec`, `ThreadRepo`, `Thread`, and `Message`. Nothing else is public;
`loop.ts`, `prompt.ts`, and `context-trim.ts` are internal.

## Dependencies

`@hermes/core`, `@hermes/llm`, `zod` — already a workspace dependency
elsewhere (`@hermes/config`); no new package. Deliberately not `@hermes/store`
(persistence arrives as an injected port, see above) or any `apps/hermes`
feature module (that boundary *is* the D4 seam).
