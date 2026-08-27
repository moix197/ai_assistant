# @hermes/core

Shared types with no dependency on any other Hermes package.

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
  of `turn` events, and stamps the same ids onto the `llm.call` it makes;
  `ToolCallEvent` still has no producer, existing so tools have a typed
  contract to emit into. `TurnEvent.outcome` is the `TurnOutcome` union —
  `"completed" | "max_iterations" | "aborted" | "error"` — so an outcome
  string can't drift. See `.ai/decisions/telemetry-event-schema.md`.
- `nextDelay()` / `delay()` — the shared exponential-backoff step and its
  sleep. Both the Telegram client and the LLM adapter retry off these rather
  than each rolling their own curve.
- The provider-neutral LLM types — `Message`, `MessageRole`, `ToolCall`,
  `ToolResult`, `Usage`, `LlmUsageEntry`. They live here, not in
  `@hermes/llm`, precisely because `store` and (later) `agent` need to name
  them without depending on the adapter: `LlmUsageEntry` is re-exported by
  both `llm` and `store`, so neither side can drift a field apart without a
  type error.
