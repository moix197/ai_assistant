# The DB test lane refuses to run against the app database

**Decision:** `packages/store/src/__tests__/db-env.ts` throws at import time —
before any suite runs — when `TEST_DATABASE_URL` equals `DATABASE_URL`, or when
it names a database whose name does not end in `_test`. Separately,
`pnpm test:db` refuses to start when `TEST_DATABASE_URL` is unset. Both store
test scripts run `vitest run --no-file-parallelism`.

**Why:** `llm_usage` is not test data. It is the ledger the monthly ceiling
spends against, so a row a test writes is money an operator no longer gets to
spend, and a row a test deletes is money they get to spend twice.

- **This already happened.** A `provider: "p", model: "m1", cost_usd: 0.005`
  fixture row from `llm-usage-repo.test.ts` was found in the `hermes` database
  and was 92% of the month's apparent spend ($0.005424 reported vs. $0.000424
  real). A `test:db` run had been pointed at the app database. Nothing detected
  it and nothing could have: the ceiling's contract is to trust whatever
  `recordUsage` wrote — see
  [monthly-budget-ceiling](monthly-budget-ceiling.md).
- **The damage runs both ways.** Both `llm_usage` suites open with
  `DELETE FROM llm_usage`, so a mistargeted run does not merely add phantom
  spend, it can erase a month of real spend and reset the cap to nearly full.
- **Two independent checks, because either alone has a hole.** Matching
  `DATABASE_URL` catches the app database even when it is not named `hermes`;
  the `_test` suffix catches a hand-typed URL on a host where `DATABASE_URL`
  happens to be unset.
- **It throws rather than skips.** A silent skip is precisely how the original
  misconfiguration survived. The same reasoning drives `test:db`'s unset-URL
  gate: every suite is `describe.skipIf(!testDatabaseUrl)`, so a lane with no
  URL produces a green empty run that is indistinguishable from a passing one.
- **Serial execution is load-bearing, not tuning.** The two `llm_usage` files
  truncate and seed the same real table; run in parallel they race and fail
  25/25, serially they pass 25/25.
- **The blast radius grows with deployment.** `DATABASE_URL` is a local
  container today; the project intends a VPS, where the same slip corrupts
  production cost accounting from a developer's laptop.

**Rejected:**

- *Skipping instead of throwing on a bad URL* — reproduces the exact invisible
  failure the guard exists to end.
- *A single check* — see the two holes above.
- *Blocklisting the name `hermes`* — hard-codes today's deployment. The `_test`
  suffix is a positive assertion about the scratch database instead, and keeps
  holding when the app database is renamed or moved to a VPS.
- *Cleaning up stray rows after the fact* — requires someone to notice, and
  nothing reports the discrepancy.

**Constraints it creates:**

- The scratch database must be named `*_test`. Renaming it breaks the lane by
  design.
- A new DB integration suite must take its URL from `db-env.ts`'s exported
  `testDatabaseUrl`, never from `process.env.TEST_DATABASE_URL` directly —
  reading the env var directly opts out of both checks.
- Do not drop `--no-file-parallelism` from the store scripts to speed the lane
  up.
- Any future table the ceiling or `/stats` telemetry reads inherits this rule:
  a row a test writes is a number an operator will act on.
