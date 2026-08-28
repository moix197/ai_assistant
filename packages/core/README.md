# @hermes/core

Shared types with no dependency on any other Hermes package. Depends on
`zod` — a leaf, third-party validation library, not another `@hermes/*`
package — so `Message` can be schema-first (see below); the zero-dependency
posture this package is otherwise built on is about workspace-package
coupling ("so lower packages can be depended on without depending on their
implementations"), which a leaf library already load-bearing in
`packages/agent`/`packages/config` doesn't touch.

- `Result<T, E>` (`ok`/`err`) — explicit success/failure values instead of
  throwing for expected error paths.
- `newId()` — `crypto.randomUUID()` wrapper.
- `Clock` — `now(): Date` port + `systemClock` real implementation, so
  time-dependent code can be tested with a fake clock.
- `Logger` — a port (`debug`/`info`/`warn`/`error`) plus `createLogger()`, a
  ~30-line, dependency-free JSON-line implementation. Each line is
  `{ ts, level, msg, ...fields }`. Lines below the configured `level` are
  dropped.
- `TelemetryRecorder` — a port: `record(event: TelemetryEvent): void`,
  synchronous and non-throwing by contract. `packages/telemetry` ships the
  real implementation (`createBufferedTelemetryRecorder`); this package only
  owns the port and the event shape, per ROADMAP §3.
- `TelemetryEvent` — a discriminated union on `name`: `LlmCallEvent`
  (`"llm.call"`), `ToolCallEvent` (`"tool.call"`), `TurnEvent` (`"turn"`).
  `threadId`/`turnId` are nullable on every variant because they only become
  real ids once `packages/agent` assigns them — a call made outside a turn
  still carries `null` for both. `packages/agent`'s `runTurn` is the producer
  of `turn` events, stamps the same ids onto the `llm.call` it makes, and
  (since Phase 2's tool loop) is also the producer of `ToolCallEvent` via
  `finishToolCall` — one per tool call, `approved: true` unconditionally
  until Phase 3's approval gate lands. `TurnEvent.outcome` is the `TurnOutcome` union —
  `"completed" | "max_iterations" | "aborted" | "error"` — so an outcome
  string can't drift. See `.ai/decisions/telemetry-event-schema.md`.
- `nextDelay()` / `delay()` — the shared exponential-backoff step and its
  sleep. Both the Telegram client and the LLM adapter retry off these rather
  than each rolling their own curve.
- The provider-neutral LLM types — `Message`, `ToolCall`, `ToolResult`,
  `Usage`, `LlmUsageEntry`. They live here, not in `@hermes/llm`, precisely
  because `store` and (later) `agent` need to name them without depending on
  the adapter: `LlmUsageEntry` is re-exported by both `llm` and `store`, so
  neither side can drift a field apart without a type error.
  `Message`/`SystemMessage`/`UserMessage`/`AssistantMessage`/`ToolMessage`
  are **schema-first**: each a `z.object` (the union, `messageSchema`, a
  `z.discriminatedUnion("role", ...)`), with the exported TS types being
  `z.infer<typeof ...>` rather than hand-written — a hand-mirrored copy of
  this shape anywhere else (e.g. a duplicate schema in `packages/store`)
  would be exactly the kind of drift CLAUDE.md's DRY rule exists to prevent.
  `AssistantMessage` carries an optional `toolCalls` (present when the model
  requested tool calls this turn — this message must precede the `role:
  "tool"` results answering it); `ToolMessage` carries a mandatory
  `toolCallId` (the `ToolCall` this message answers — unrepresentable
  without one, since every OpenAI-compatible provider rejects a `role:
  "tool"` message missing it). `@hermes/llm`'s adapter maps both onto the
  wire's `tool_call_id`/`tool_calls` keys rather than spreading the domain
  shape verbatim. `messageSchema`/`messagesArraySchema` are exported so
  `@hermes/store` can validate a `threads.messages` jsonb row against this
  exact shape at read time (`parseValidatedJson`, see
  `packages/store/README.md`) instead of casting.
