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
- `TelemetryRecorder` — a **port only**, no implementation. Nothing in this
  PRD calls it; it exists so packages depend on `core`'s port rather than a
  concrete telemetry package, per ROADMAP §3. An implementation lands later,
  in a dedicated `packages/telemetry` (see `plans/ROADMAP.md`), once that
  package is built.
