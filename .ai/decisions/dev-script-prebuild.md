# `pnpm dev` rebuilds every workspace package first (`predev`)

**Decision:** Root `package.json` gets a `predev` script — `pnpm -r build` —
which pnpm runs automatically before `dev` (`tsx watch apps/hermes/src/
index.ts`). `pnpm dev` on its own now always starts against freshly built
workspace-package `dist/` output.

**Why:**

- **Real incident:** a live Telegram `sheets_write` approval rendered as the
  raw-JSON fallback (`The model wants to run: sheets_write({...})`) instead of
  the legible Spanish block, even though `packages/google-sheets/src/tools/
  sheets-write.ts` already declared `prepare` and `packages/agent/src/loop.ts`
  already forwarded `outcome.summary` onto the batch entry — both landed in
  the same commit (`405288d`) that also touched `apps/hermes/src/agent/
  telegram-approval-gate.ts` (the `Aprobar`/`Rechazar`/`Aprobado.` copy the
  same conversation *did* see live). The dev bot was started via root `pnpm
  dev`, which only watches `apps/hermes/src` — it never rebuilds
  `@hermes/agent`/`@hermes/google-sheets`. Both packages' `package.json` sets
  `"main": "./dist/index.js"`, and Node's real module resolution (unlike
  `tsconfig.base.json`'s `@hermes/* → src` `paths`, which only steers `tsc`/
  editor tooling) follows that field — so the running process kept serving
  whatever `dist/` last happened to contain, silently diverging from the
  edited source. `apps/hermes`'s own file changes took effect immediately
  (`tsx watch` reads its source directly); its dependencies' changes took
  effect only once someone remembered to rebuild them.
- **The CI lane already assumes this and guards for it** — `.github/
  workflows/ci.yml` runs `pnpm build` before `pnpm test` specifically because
  "cross-package value imports... resolve through each package's `main` →
  `dist`, so the suites cannot even collect in a fresh checkout until the
  workspace is built." `pnpm dev` was the one entry point with no equivalent
  step. `predev` closes that gap the same way, for the same reason, on the
  interactive dev loop instead of CI.
- **This is a real, reproducible failure mode, not a one-off:** the
  regression test added alongside this fix
  (`apps/hermes/src/agent/__tests__/sheets-write-approval-composition.test.ts`)
  fails with exactly the symptom above (`request.plan`/`request.summary`
  both `undefined`) when `packages/agent/dist` predates the `summary`-
  forwarding change, and passes once that package is rebuilt — confirmed by
  hand before adding `predev` (Vitest resolves `@hermes/*` bare specifiers
  the same way Node does: through `main`, i.e. `dist`, matching the CI
  comment above — there is no `tsconfig-paths` plugin in this workspace).

**Constraints it creates / residual gap (accepted, not solved here):**

- `predev` only guarantees freshness at the moment `pnpm dev` *starts*. It
  does **not** watch-rebuild a dependency package while `pnpm dev` keeps
  running — editing `packages/google-sheets/src/**` mid-session still needs
  its own `pnpm --filter @hermes/google-sheets build` (or restarting `pnpm
  dev`) before the change is live. A full watch-all-packages setup was
  rejected as scope creep for this fix (`lean-docker-build.md` already
  rejected bind-mounted source for the analogous Docker case, for the same
  reason — the dev loop is meant to stay simple). Anyone iterating on a
  `packages/*` file while `pnpm dev` is running should rebuild that package
  by hand.
- Same risk exists for `pnpm --filter <pkg> test`/`vitest` run directly
  against a single package whose workspace dependencies were edited but not
  rebuilt — `predev` does not cover that path either. `pnpm test` (root) is
  safe because it runs after `pnpm build` in the documented workflow/CI
  ordering; running a package's test script in isolation is not.
