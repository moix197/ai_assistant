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
  `threadId`/`turnId` are nullable on every variant because they don't exist
  as real ids until `packages/agent` (2c) assigns them — `packages/llm`'s
  adapter, the only producer wired up so far, always passes `null` for both.
  `ToolCallEvent`/`TurnEvent` have no producer yet; they exist so 2c has a
  typed contract to emit into.
