# Lean 3-stage Docker build via `pnpm deploy --filter`

**Decision:** The `Dockerfile` is three stages — `build` (workspace install +
`pnpm -r build`), `deploy` (`pnpm deploy --filter ./apps/hermes --prod --legacy
/out`), `runtime` (`node:22-alpine`, `COPY --from=deploy /out .`, `USER node`,
exec-form `CMD`). The runtime image contains one app's production dependency
graph, not the workspace.

**Why:**

- **A monorepo must not imply a monolithic image.** ROADMAP D4's long-term aim
  is one agent per VM, selected by env var. What makes that possible is a build
  that can already emit a lean single-app image. `pnpm deploy` is that
  capability, and taking it now costs one extra stage — adding it later means
  re-deriving the dependency graph and re-testing the image under deadline.
  This is a seam reserved at ~zero cost, in the spirit of D4, not machinery
  built for a feature that doesn't exist.
- **Package manifests are copied before the source.** Docker layer caching then
  keeps `pnpm install --frozen-lockfile` off the critical path for a
  source-only change.
- **`--frozen-lockfile` is the backstop for the workspace `paths` mapping.**
  `tsconfig.base.json` maps `@hermes/* → src`, which means a *removed*
  workspace dependency wouldn't fail typecheck locally. The Docker install
  catches it instead.
- **Exec-form `CMD` is load-bearing, not style.** Shell-form wraps the process
  in `/bin/sh`, which does not forward SIGTERM to Node — the graceful drain
  would never run and Docker would SIGKILL after the grace period. Do not
  "simplify" this to a string.
- `USER node` in the runtime stage: no reason for this process to be root.

**Non-obvious flags** (both were discovered the hard way; neither is
decoration):

- `--filter ./apps/hermes`, a **path** filter, not `--filter hermes`. A name
  filter matched two projects and failed with `ERR_PNPM_CANNOT_DEPLOY_MANY`
  until the root package was renamed `hermes-monorepo`. The path filter is
  immune to that class of collision regardless of naming.
- `--legacy` is required on pnpm >= 10 for non-injected workspaces; without it,
  `pnpm deploy` leaves workspace deps as symlinks pointing outside `/out`
  (`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`) and the runtime image can't resolve
  them.

**Rejected:**

- *Single-stage build shipping the whole workspace* — drags devDependencies and
  every sibling package into the runtime image, and forecloses per-app images.
- *Bind-mounting source into the compose service for hot reload* — slow and
  flaky on WSL2/Windows. The dev loop is `docker compose up -d postgres` +
  `pnpm dev` natively against the compose-owned Postgres, which is why
  `docker-compose.yml` publishes `5432:5432`.

**Constraints it creates:**

- Adding a workspace package means adding its `COPY <pkg>/package.json` line to
  the build stage. Miss it and the install layer resolves against an incomplete
  workspace.
- Anything the runtime needs at run time must be listed in a package's `files`
  and be a real dependency — `pnpm deploy --prod` copies nothing else. This is
  why `@hermes/store` ships `src/migrations` in `files`: the migration runner
  reads those `.sql` files from disk at boot.
- The compose `hermes` service stays `replicas: 1`. Scaling it out is not a
  configuration choice — see
  [telegram-long-polling-correctness](telegram-long-polling-correctness.md).
