# Telemetry event schema — one wide table, a typed union, and a hard cost-source split

**Decision:** `@hermes/core`'s `TelemetryEvent` is a discriminated union on
`name` (`llm.call` / `tool.call` / `turn`), and every variant lands in one
`telemetry_events` table shaped wide-plus-jsonb-tail: the columns a rollup
filters or aggregates on (`name`, `created_at`, `thread_id`, `turn_id`,
`tool_name`, `duration_ms`, `cost_usd`, `is_error`) are real columns; everything
event-specific goes in a `fields` jsonb bag. `/stats` reads its **spend** from
`llm_usage` and everything else from `telemetry_events` — never the reverse.

**Why:**

- **A union, not the original free-form `{ name, fields? }`.** `packages/agent`
  (2c) is the future producer of `tool.call` and `turn`, and it does not exist
  yet. Defining all three now means 2c emits into a contract that already
  matches the table's columns instead of inventing a shape and forcing a
  migration. It also makes `toRow`'s column mapping exhaustive: a fourth event
  kind fails to compile until it is given one. `threadId`/`turnId` are nullable
  on every variant for the same reason — no real ids exist until 2c, and the
  only producer shipped (`packages/llm`'s adapter) passes `null` for both.
- **Wide-plus-jsonb, not pure jsonb and not a column per field.** The whole
  reason this table exists is that Postgres, not Node, should do the rollup
  math; a pure-jsonb blob makes every aggregate a scan and defeats the indexes.
  A column per field goes the other way and needs a migration per new event
  kind. The split is drawn at exactly the line "does a query filter or
  aggregate on it," which is why `cost_usd` and `is_error` are columns while
  `model` and the token counts are not.
- **The cost-source split is an invariant, and the type shape enforces it
  before any test does.** `/stats`' spend and cap must agree with the ceiling
  they are reported against, so they come from the *same* `sumCostSince`
  function `assertBudgetNotExceeded` calls — `apps/hermes` wires one
  `@hermes/store` implementation into both `llm`'s `BudgetUsageRepo` and
  `telemetry`'s `StatsRepo`. `LlmCallStats` (`getLlmCallStatsSince`'s return)
  deliberately carries **no cost or dollar field at all**: there is no value in
  that object a future edit could plausibly wire into the spend line, because
  the type does not have one. `packages/telemetry/src/__tests__/stats.test.ts`
  then proves it behaviorally by feeding the two sources *deliberately
  mismatched* fakes — `sumCostSince` returning a distinctive figure while
  `getLlmCallStatsSince` reports zero calls — and asserting the rendered spend
  line shows that figure and nothing else. A test that only asserted "both
  functions were called" would prove nothing about which number reached which
  line.
- **"Error rate" has exactly one definition: the share of `llm.call` rows with
  `is_error = true`.** A budget-ceiling rejection is excluded *by construction*,
  not by a filter: `assertBudgetNotExceeded` throws before any provider call is
  attempted, so no `llm.call` event is emitted at all. A policy stop and a call
  failure are different things and must never be conflated in the one number
  `/stats` labels "error rate." Stated here so it cannot be reinterpreted the
  next time someone adds an event.
- **Delivery is at-most-once, deliberately** — the inverse of `llm_usage` and
  `llm_dedupe`, which are correctness-critical and written synchronously.
  Telemetry is a cost *instrument*, not a ledger; buying a stronger guarantee
  (a WAL-backed outbox, retries) would put a blocking or failing write back on
  the paid completion path, which is the one thing this design exists to avoid.

**Rejected:**

- *Prometheus / Grafana / OTel now* — ROADMAP D2 rejects the container sprawl
  at this size. The event shape is flat enough that an exporter can bolt on
  later; none is built.
- *A table per event kind* — three tables to join for a single `/stats` reply,
  and a fourth for every event 2c adds.
- *Deriving `/stats`' spend from `telemetry_events.cost_usd`* — it would be
  convenient (one source for the whole reply) and it would be wrong: the event
  write is lossy on purpose, so a dropped batch would understate spend against
  the very ceiling the number is compared to.
- *Emitting an `llm.call` event on a budget rejection with zeroed fields* —
  costs the error-rate definition its meaning for no gain.

**Constraints it creates:**

- Anything read by a rollup query must be a real column. Adding a field to
  `fields` that a query then filters on is the drift this shape exists to
  prevent — add the column and the migration instead.
- Do not add a cost/dollar field to `LlmCallStats`, however convenient it looks
  for a future feature, without a deliberate decision that replaces this one.
- `record()` must stay synchronous, non-blocking and non-throwing at every call
  site: never `await recorder.record(...)`, never let it become a reason a
  reply is late or lost.
- New event kinds get a `toRow` case and, if they carry a queryable dimension,
  a column — not a `fields` key that someone later regrets.

**Open items (accepted, not solved here):**

- **No retention or pruning policy.** `telemetry_events` grows unbounded from
  migration `004` onward. This is a known, named gap, not an oversight —
  whoever needs a bounded table (or the first operator to notice the disk)
  owns picking a window and writing the pruner.
- **`cost_usd` is shared by two event kinds with different meanings.**
  `llm.call.costUsd` (one call) and `turn.totalCostUsd` (the sum over a turn's
  calls) both map to the same `cost_usd` column. Nothing double-counts today
  because 2c ships no `turn` producer — but the moment one exists, a naive
  `SUM(cost_usd)` across all event kinds counts each call's cost twice. Every
  query in the tree today filters `name = 'llm.call'` first, which is what
  makes it safe; recorded here so the hazard is found before it bites rather
  than after. Whoever wires the `turn` producer should decide then whether to
  split the column or keep the discipline of always filtering on `name`.
- **`maxBufferSize` bounds an event *count*, not bytes.** Every event shipped
  today has a small fixed-shape payload, so this is not yet a live risk. 2c's
  `ToolCallEvent` will carry a tool result, which can be large and unbounded;
  revisit a byte-size cap at that point.
- **`created_at` is flush time, not event time.** Buffering means an event
  occurring within one flush interval of a UTC day/month boundary can land in
  the adjacent bucket. Accepted for an instrument; it would not be for a
  ledger.
