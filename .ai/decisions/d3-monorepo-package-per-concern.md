# D3 — Monorepo, one package per concern, created at its phase

**Decision:** One pnpm workspace holding the whole system. Every concern the
roadmap knows will be separate gets its own package **in the phase where it
first appears** — never grown inside another package and extracted later, and
never scaffolded ahead of its phase. The skeleton phase therefore created
exactly `apps/hermes`, `packages/core`, `packages/config`, `packages/store`,
`packages/channels`, and nothing else; `packages/llm` appeared only when the
LLM-port phase actually needed it. No empty `agent/`, `telemetry/`, or
`google-*` directories exist, and their absence is the decision, not an
oversight. `packages/google-sheets` is the latest instance: created in
`05-google-sheets` Phase 4, the phase that first needed a Sheets capability —
not scaffolded alongside `google-auth` one plan earlier, even though it was
already named on the roadmap. `scheduler` and `ingress` remain absent for the
same reason.

**Why:**

- *Monorepo over separate repos* — this is one system with shared domain types,
  not independent products. Changing the `Channel` interface across a repo split
  would mean an npm publish and a version bump; here it's one atomic commit.
- *Create-at-phase over merge-then-split* — an unenforced boundary decays. Code
  reaches across it because nothing stops it, and by extraction time there is no
  clean seam left, only entangled imports. The module system is the only thing
  that makes a boundary real, so it has to be there from the first line of code
  that belongs behind it. Merge-then-split costs more in both the short and the
  long term.
- *No scaffolding ahead of phase* — an empty package is speculative structure
  that invites the wrong code and rots un-reviewed. The one deliberate exception
  is the `TelemetryRecorder` **port** in `core`: the boundary rule ("nothing
  imports `telemetry` directly") requires the port to pre-date the
  implementation, or it gets retrofitted through half the tree. It is a
  type-only export with zero runtime footprint and no callers.

**Rejected:**

- *Separate repos per package* — publishing and version-juggling for a
  single-tenant system, to buy an independence nothing needs.
- *One package now, split when it hurts* — the failure mode described above.
  "When it hurts" is precisely when the seam no longer exists.
- *Scaffold the whole roadmap's package list up front* — creates ten boundaries
  nobody is defending and files nobody has reviewed.

**Constraints it creates:**

- Dependencies flow strictly downward; a package never imports one above it, and
  two packages that need each other mean a third package is missing. Concretely:
  `channels` does not import `store` — it takes an injected offset port.
- New code goes in the package that owns its concern. If none does, create the
  package; do not park it in the nearest one "for now".
- A monorepo is not one deployable. The Docker build must keep emitting a lean
  single-app image (see [lean-docker-build](lean-docker-build.md)) — that is
  what keeps ROADMAP D4's one-agent-per-VM aim reachable.
- The workspace `paths` mapping in `tsconfig.base.json` (`@hermes/* → src`) is
  kept deliberately: dropping it would catch a removed workspace dependency, but
  breaks `pnpm -r typecheck` on a clean clone, since typecheck runs before
  `dist/` exists. The frozen-lockfile install in Docker is the backstop instead.
- The UTC-calendar-month boundary check (`startOfCurrentUtcMonth`,
  `packages/llm/src/budget/check-budget.ts`) is duplicated into
  `packages/telemetry`'s `computeStats` rather than shared, because sharing it
  means one of the two importing the other, and a six-line function does not
  earn a third package. Revisit only if a third consumer needs the same
  boundary logic, or the helper grows past a trivial calculation. See
  [llm-cost-accounting](llm-cost-accounting.md) and
  [monthly-budget-ceiling](monthly-budget-ceiling.md).
