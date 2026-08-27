# @hermes/telemetry

The real implementation behind `@hermes/core`'s `TelemetryRecorder` port.
Depends on `@hermes/core` only — same shape as `@hermes/llm` and
`@hermes/channels` — and never imports `@hermes/store` directly; a small
injected `TelemetryEventRepo` port stands in for it, exactly like `@hermes/llm`'s
`LlmUsageRepo`/`BudgetUsageRepo`. `apps/hermes/src/telemetry/build-telemetry-recorder.ts`
(Phase 2) is the one place that wires the port to `@hermes/store`'s real
`insertEvents`.

**Unwired as of this phase.** Nothing outside this package's own tests calls
`createBufferedTelemetryRecorder` yet — `packages/llm`'s adapter and
`apps/hermes/src/boot.ts` are wired in Phase 2. This package's own
`recorder-integration.test.ts` proves the mechanism against a real Postgres
using a thin in-test wiring, not the production wiring, which doesn't exist
yet.

## Recorder contract

`createBufferedTelemetryRecorder(repo: TelemetryEventRepo, opts?)` returns a
`TelemetryRecorderHandle`, a `TelemetryRecorder` plus `stop(): Promise<void>`.

`record(event)` is **synchronous, non-blocking, and never throws** — under
every documented failure mode below, not just the happy path. This is
load-bearing: the recorder sits directly on the paid LLM completion path
(Phase 2), and a `record()` that blocks, slows, or throws would turn an
observability nicety into a new way to fail a user's message.

- **Normal operation:** the event is pushed onto an in-memory buffer and
  `record()` returns. Reaching `flushThreshold` (default `50`) triggers a
  flush immediately — fire-and-forget, never awaited by `record()` itself.
  Independently, a timer (`flushIntervalMs`, default `5000`) flushes
  whatever is buffered on every tick, even when nothing has accumulated —
  `@hermes/store`'s `insertEvents` is the layer that no-ops on an empty
  batch, not this package.
- **Flushes are single-flighted.** Only one `insertEvents` call is ever in
  flight at a time. If `flushThreshold` is reached (or the timer ticks)
  while a flush is still pending — e.g. Postgres is slow — that trigger is
  a no-op: the buffer keeps accumulating instead of a second concurrent
  flush starting. This is what makes `maxBufferSize` the real backpressure
  valve rather than an unreachable upper bound under the default config
  (`flushThreshold` 50 well below `maxBufferSize` 500).
- **Buffer overflow:** once the buffer holds `maxBufferSize` events (default
  `500` — a **count**, not a byte size), the newest incoming event is
  dropped and `logger.warn` fires. The buffer never grows past this bound.
  This is the intended backpressure valve for a burst that outruns
  Postgres, not a bug: telemetry *fidelity* degrades (some events missing),
  the caller is never blocked or slowed.
- **A flush's `repo.insertEvents` call rejects:** the batch that was in
  flight is logged at `error` and discarded — no requeue, no retry. The
  recorder does not enter a broken state: the next interval tick or
  threshold trigger flushes normally, so a transient Postgres outage
  self-heals the moment it's reachable again, losing only the events that
  were in the failed batch.
- **`record()` called after `stop()` has resolved:** the event is dropped
  (same drop path as overflow, including the `logger.warn`) — never
  buffered, never flushed. `stop()` is a real terminal state.
- **Delivery is at-most-once, not exactly-once — accepted, not a bug.** A
  process crash between buffering and flushing loses the buffered events.
  Telemetry is a cost *instrument*, not a financial ledger (unlike
  `llm_usage`/`llm_dedupe`); a stronger guarantee here would mean a
  blocking or retrying write on the paid completion path, which is the
  exact risk this design avoids.

## `stop()` / drain semantics

`stop()` clears the interval, then — after awaiting any flush already in
flight — awaits **one** final flush of whatever remains buffered. It has
**no internal timeout** — it awaits `repo.insertEvents` for as long as that
takes. Bounding how long a caller waits on `stop()` (e.g. a process
shutdown sequence) is the caller's job; `packages/telemetry` has no concept
of a process-wide shutdown budget. See `apps/hermes/src/boot.ts` (Phase 2)
for the time-boxed call site. `stop()` is idempotent: calling it again
after it has already resolved (or while the first call is still in
flight) is a no-op that resolves without a second flush.

## `created_at` is flush time, not event time

`telemetry_events.created_at` is stamped by `insertEvents` at flush time, not
when `record()` was called. Buffering plus the flush interval means an event
can land in the adjacent day's or month's bucket if it occurs within one
flush interval of a UTC boundary — a rollup counting it in "today" or "this
month" may occasionally disagree with when the event actually happened.

## Testing

`src/__tests__/recorder.test.ts` (always runs, no DB) covers every behavior
above against a mock `TelemetryEventRepo` and fake timers: synchronous
non-awaiting `record()`, threshold-triggered flush, independent periodic
flush, overflow drop-and-warn under a burst larger than `maxBufferSize`,
single-flighting a slow flush under the *default* config so `maxBufferSize`
(not a pile of concurrent `insertEvents` calls) absorbs the burst, a
rejected flush logged at `error` without wedging the recorder (a second,
later flush still succeeds), post-`stop()` drops, and `stop()`'s
drain-then-stop-interval behavior.

`src/__tests__/recorder-integration.test.ts` is integration-only, gated on
`TEST_DATABASE_URL` (same convention as `packages/store`'s DB-gated
suites — see `packages/store/README.md`): a real recorder wired to
`@hermes/store`'s real `insertEvents`, fed one hand-built `llm.call` event,
drained via `stop()`, then read back directly from `telemetry_events` —
this is the phase's headline end-to-end proof.
