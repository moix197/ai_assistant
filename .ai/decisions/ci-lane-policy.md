# CI runs the hermetic lanes only; `test:live` is excluded, provably

**Decision:** `.github/workflows/ci.yml` — this repo's first CI — runs
`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` and `pnpm test:db` on
every push and pull request against `main`, the DB lane against a
health-checked `postgres:16` service container. `pnpm test:live` is never
invoked by CI. `packages/llm/src/__tests__/live-lane-excluded.test.ts` proves
the exclusion instead of asserting it.

**Why:**

- **The live lane spends real money.** It calls provider APIs with real billed
  tokens. A lane that costs money per push is a lane that quietly bills for
  every typo-fix commit and every rebase-triggered re-run.
- **It has already been observed hard-failing on quota.** `01-llm-port` Phase 6
  recorded **7 of 10** Gemini free-tier trials returning `HTTP 429`. That is
  the concrete evidence, not a hypothetical: a red CI check caused by someone
  else's rate limiter teaches the team to ignore red checks.
- **CI's job here is to make the previous PRDs' claims real.** Until this
  workflow, every "tests pass" in `00-skeleton`, `01-llm-port` and Phases 1–4
  of this PRD rested on a human running scripts locally. `test` and `test:db`
  are both hermetic — no credentials, no network to a paid provider — so they
  can be trusted to run unattended.
- **The primary defense against a billed CI run is that CI holds no
  credentials.** This workflow sets no `LLM_*` variable and reads no repository
  secret, and `.env` is not in the checkout — so `missingLiveEnvKeys` comes back
  non-empty and every live suite *skips itself* even if something did invoke it.
  A defense that depends on a flag staying correct is weaker than one that
  depends on a secret never existing; the exclusion below is defense in depth on
  top of this, not the thing standing between the repo and a bill.
- **The exclusion is one flag, and a flag is exactly the kind of thing that
  silently rots.** `packages/llm`'s `test` script excludes `**/*.live.test.ts`.
  Nothing checked that flag except a human reading it, which `01-llm-port`
  Phase 6 itself flagged as unverifiable by inspection. The guard test reads the
  glob back out of `package.json` at run time and asserts (a) live files exist
  to exclude, (b) the glob matches all of them, (c) the set the unit lane would
  run contains none of them, (d) every `*.test.ts` under the directory
  `test:live` points `--dir` at is excluded too — the paid lane is a directory,
  so `live/foo.test.ts` is billed without ever carrying the suffix. It walks
  from the workspace root, so all four checks cover every package, not just
  `packages/llm`. Narrow the flag, mistype it, delete it, or drop a plain
  `*.test.ts` into the live directory and the test goes red in the same lane CI
  runs.
- **CI satisfies the DB guard as written rather than carving itself out.** The
  service container's `POSTGRES_DB` is `hermes_ci_test`, so
  `assertNotTheAppDatabase`'s `_test`-suffix check passes with no CI-only
  branch in `db-env.ts` — see
  [test-database-isolation](test-database-isolation.md). `DATABASE_URL` is not
  set anywhere in the job, so the guard's other check cannot be tripped by a
  collision and nothing in the suites can reach an app database.
- **`TEST_DATABASE_URL` is scoped to the `test:db` step, not the job.** The DB
  suites are `describe.skipIf(!testDatabaseUrl)` inside files the unit lane also
  collects. A job-level value would therefore un-skip them under `pnpm test`
  (`pnpm -r test`, workspace concurrency > 1) and run every package's DB suite
  in parallel against the one service container — the exact race `test:db`'s
  `--workspace-concurrency=1` exists to prevent, plus concurrent
  `runMigrations`. Step-level `env:` keeps the two lanes as separate as they are
  locally.

**Accepted residual risk:**

- **A live-provider regression is not caught by CI.** A wire-shape change, a
  renamed usage field, or a provider dropping cache-hit token reporting would
  pass every CI lane and only surface in production or in a manual run. The
  mitigation is a **periodic manual `pnpm test:live`**, notably before a
  release and after any change to the adapter's request/response mapping.
  There is no automation behind that today, on purpose — automating it
  reintroduces both the cost and the quota flakiness above.

**Rejected:**

- *Running `test:live` on a schedule (nightly cron)* — same billed calls and
  the same free-tier quota, just at a time when nobody is watching the failure.
- *Running `test:live` only on `main` pushes* — still bills, still flakes, and
  puts the flake on the branch whose red state matters most.
- *Gating it behind a `[live]` commit-message trigger or a manual
  `workflow_dispatch`* — machinery for a lane that is run by hand a few times a
  release; the manual run is already the mitigation, and the indirection would
  need its own secrets in the repo.
- *Asserting the exclusion in a README line or a code comment* — that is the
  status quo this decision exists to end.
- *A second CI job or a matrix* — one job, one Postgres, one dependency
  install. Splitting the lanes buys parallelism this repo's test suite does not
  need and costs a second install.

**Constraints it creates:**

- **`pnpm build` must stay ahead of the test lanes in CI.** Cross-package value
  imports resolve through each package's `main` → `dist`, so in a fresh
  checkout the suites cannot even collect until the workspace is built. This is
  not a packaging step that could be dropped for speed.
- **A new live test must end in `.live.test.ts` or sit under the directory
  `test:live` points `--dir` at.** Both are enforced: the suffix by the
  exclusion glob, the directory by the guard's fourth check. A live suite that
  is neither runs in CI — though with no `LLM_*` keys there it would skip, not
  bill.
- **A package that gains a live suite must also gain the `--exclude` flag.**
  The guard walks the whole workspace and resolves each live file against *its
  own* package's `test` script, so a live file in a package whose `test` script
  passes no `--exclude` fails the guard by name. Nothing about a second live
  lane needs the guard itself edited.
- **Branch protection is a repository setting, not a file here.** Requiring the
  `ci` check to pass before merge has to be enabled in GitHub's settings by a
  human; the workflow alone only reports, it does not block.
