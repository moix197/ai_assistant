# @hermes/agent

The bounded agentic loop: turns a stateless single-shot LLM reply into a real
multi-turn conversation with restart-safe history. This phase (Phase 1 of
`plans/03-agent-core.md`) ships the loop's simplest shape — load thread, trim
history, call the model once, persist, reply — with no tools yet. Phase 2
adds the tool registry and a real multi-iteration loop; Phase 3 adds the
approval gate.

## Port contract

`src/types.ts`:

- `Message` — reused from `@hermes/core`, never redefined.
- `ToolSpec { name, description, schema: z.ZodTypeAny, handler, requiresApproval }`
  — a tool made available to the model. No real caller until Phase 2; this
  phase only proves `ToolSpec[]` can be empty. No mutable `register()`: tools
  are supplied once, at `AgentDefinition` construction, because
  registration-order nondeterminism would threaten the byte-stable prefix
  invariant #6 depends on.
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
calls with the same `definition` produce byte-identical output — proven this
phase with `definition.tools = []` (`__tests__/prompt.test.ts`); Phase 2
reuses this same function unmodified once tools are non-empty. This is what
lets `/stats`' cache-hit rate (`02-telemetry`) actually move: a provider can
only cache a prefix that never drifts by even one byte between calls.

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

`src/loop.ts`'s `runTurn(definition, deps, channel, chatId, userText)` is
this phase's shape:

1. Load or create the thread via the injected `ThreadRepo`
   (`getOrCreateThread`).
2. Check `deps.signal.aborted` — throws `LlmAbortedError` (reused from
   `@hermes/llm`, not a new type) if already aborted, **before** any LLM call
   is attempted. `deps.signal` is a required constructor dependency, not
   optional: a deliberate reaction to `02-telemetry` Phase 6's own "mechanism
   built but never wired" bug, where the boot `AbortController`'s signal had
   been wired into the LLM adapter but never into the Telegram poller.
3. Assemble the prefix (`assemblePrefix`) and trim stored history
   (`trimHistory`, `HISTORY_BUDGET_CHARS`).
4. Call `llmProvider.complete(...)` once, with a freshly generated `turnId`
   (`newId()`) and the thread's real `threadId`/`turnId` on the request —
   `tools: undefined` this phase, so `MAX_TOKENS_PER_TURN` (`@hermes/llm`)
   is the only budget in play.
5. If the model returns a tool call anyway, throw a defensive, temporary
   guard ("tool calls are not supported until packages/agent Phase 2") — not
   a real code path, since `tools: undefined` means no provider should ever
   do that; removed once Phase 2 adds real handling.
6. On success: persist the user message and the assistant reply together in
   **one** `appendMessages` call, emit a `turn` telemetry event
   (`iterations: 1`, `outcome: "completed"`, `totalCostUsd` from the
   result's `costUsd`), and return the reply text.
7. On any thrown error (an already-aborted signal, a provider failure — including
   `UnpricedModelError`, which gets no special-casing — or the tool-call
   guard above): emit a `turn` event with `totalCostUsd: 0` and
   `outcome: "aborted"` (for `LlmAbortedError`) or `"error"` (everything
   else), then **rethrow the original error unchanged** — no new
   error-handling branch. The existing completion handler's generic-failure
   reply still applies.

`MAX_ITERATIONS = 8` is declared in `loop.ts` even though this phase's
traffic can never reach iteration 2 (no tools means `toolCalls` is always
empty) — Phase 2 is the first phase that can actually exercise it.

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
