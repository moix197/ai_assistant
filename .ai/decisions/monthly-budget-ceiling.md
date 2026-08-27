# Monthly budget ceiling — the one automated defense against a runaway bill

**Decision:** Before every `complete()` — before the request body is built and
before any `fetch` — `packages/llm`'s adapter sums `llm_usage.cost_usd` since
the first of the current calendar month in UTC and throws
`BudgetExceededError` when that sum **meets or exceeds**
`LLM_MONTHLY_BUDGET_USD`. `usageRepo` and `budget` are required adapter
options, wired in one place
(`apps/hermes/src/llm/build-llm-provider.ts`). The Telegram reply on a breach
is a fixed friendly string; the cap and spend figures go to logs only.

**Why:** ROADMAP §7 names token cost as the project's main financial risk, and
this is the only thing in the tree that acts on it without a human. Everything
non-obvious about it follows from that being true:

- **The check runs before the fetch, not around it.** Checking after would
  record the spend it exists to prevent. Because the check is the first
  statement in `complete()`, a breach costs zero provider calls — and the
  adapter's 429/5xx retries all sit *inside* one already-checked call, so a
  retry storm cannot multiply spend past a check.
- **`>=`, not `>`.** At exactly the cap the operator has spent what they
  authorized. Blocking there makes the configured number the actual limit
  rather than the last value that still permits another call.
- **The month window comes from an injected `Clock`, not `new Date()`.** UTC
  calendar month, so the boundary does not move with the host's timezone, and
  a rollover is testable without waiting a month.
- **`usageRepo` and `budget` are required, deliberately.** They used to be
  optional with no-op defaults, which meant a construction site could bypass
  the ceiling by *omission* — nothing throws, nothing logs, spend simply stops
  being counted. Required options turn that into a compile error. Tests that
  don't care about budget pass an explicit permissive cap instead.
- **Granularity is accepted, not overlooked.** The ceiling gates the *next*
  call against spend already recorded, never spend in flight. A call that
  passed the check completes and is recorded even if its own cost crosses the
  cap. Cumulative monthly spend is therefore bounded to within one call's cost
  of the cap, not stopped exactly at it. In 2a that window is exactly one call
  wide because the completion handler is single-shot; a 2c multi-call turn is
  where a per-turn-aware cap would be revisited.
- **The user-facing reply carries no figures.** `BudgetExceededError.message`
  holds `capUsd`/`spentUsd` for logs; the handler replies with a fixed string.
  Spend is operator information, and `/stats` (02-telemetry) is where it is
  meant to surface.
- **An absent `LLM_MONTHLY_BUDGET_USD` defaults to an effectively unlimited
  cap** so a fixture that ignores the feature need not supply one. A real
  deployment cannot slip through that door: compose's `${VAR:-}` passthrough
  sends `""` for an unset host var, which coerces to `0` and fails
  `.positive()` loudly at boot.

**Rejected:**

- *Recording spend and stopping afterwards* — the failure mode being defended
  against is the invoice, not the log line.
- *Optional `usageRepo`/`budget` with silent no-op defaults* — the previous
  shape, and the exact way a ceiling gets disabled without anyone noticing.
- *A hard stop exactly at the cap* — would need in-flight cost reservation
  (estimate output tokens before the call, reconcile after) to buy a bound one
  call tighter than the accepted one.
- *A DB-backed or per-tenant cap now* — `resolveBudgetCapUsd(env)` exists as
  the single seam so that change replaces one function body and no call site.
  Building it before a second tenant exists is speculative.
- *Surfacing cap/spend in the chat reply* — leaks operator cost figures to
  every allowlisted user by default.

**Constraints it creates:**

- The check reads only what `recordUsage` wrote, so anything that suppresses a
  write loosens the ceiling by the same amount: an unpriced model resolves to
  `$0`, a dropped insert logs and continues, and `cost_usd numeric(12,6)`
  floors sub-$5e-7 calls to zero. See
  [llm-cost-accounting](llm-cost-accounting.md) — cheap under-pricing
  is the ceiling's blind spot, which is why `MODEL_PRICING` biases high.
- The inverse is just as real and was observed: anything that *adds* rows
  tightens the ceiling in real dollars, and a test fixture is the way that
  happens. `llm_usage` is a financial ledger, not a scratch table — writing to
  it outside the adapter's success path moves the operator's actual spending
  authority, silently. See
  [test-database-isolation](test-database-isolation.md).
- Every cap read goes through `resolveBudgetCapUsd`; no call site reads the
  env value directly.
- A new adapter construction site must wire both required options against the
  same pool. `build-llm-provider.ts` is that place; keep it there.
- Until dedupe lands (01-llm-port Phase 5), the ceiling is also the second
  line of defense against a redelivered update billing twice — keep the cap
  low during development.
