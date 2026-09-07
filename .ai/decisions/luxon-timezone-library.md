# `luxon` adopted as a dependency, narrowly, for IANA-timezone/DST-correct date math

**Decision:** `packages/google-calendar` depends on `luxon` (`^3.5.0`),
used for all timezone-aware date arithmetic in `relative-time.ts` and
`timezone-cache.ts`/`window-bounds.ts`'s supporting logic — resolving a
relative-time intent (`resolveRelativeInstant`/`resolveRelativeWindow`)
against the user's own IANA zone (`America/New_York`, etc.) and "now".
Everything else in this package — the REST client, retry wiring, the
idempotency id — is homemade, per CLAUDE.md's "build our own by default"
rule.

**Why:**

- **Load-bearing.** IANA-timezone/DST-correct date math is exactly the kind
  of spec CLAUDE.md names as worth a dependency: a UTC-offset calculation
  that's correct on most days and silently wrong across a DST transition
  boundary is a much worse failure mode than never handling it at all — a
  user's "tomorrow at 2pm" landing an hour off is the kind of bug that looks
  fine in every manual test except the two days a year it matters.
  `plans/08-calendar.md`'s Dependencies & Risks calls this out explicitly:
  "luxon is adopted specifically so this isn't hand-rolled."
- **Low-risk.** Widely adopted, actively maintained, a stable API for the
  narrow surface used here (`DateTime.fromISO`, `.setZone`, `.plus`/`.minus`,
  `.set`, `.startOf`, `.toUTC().toISO()`). Ships its own TypeScript types, no
  `@types/luxon` needed. Small, dependency-free package (`luxon` has zero
  runtime dependencies of its own) — no supply-chain surface beyond the
  library itself.
- **Used narrowly, not as a framework.** Only `DateTime` is imported;
  `relative-time.ts`'s functions remain pure (no I/O), and `luxon` never
  reaches into `calendar-client.ts`'s HTTP layer or this package's public
  return shapes, which stay plain ISO strings.

**Rejected:**

- *Hand-rolled UTC-offset math* — naive `Date`/offset arithmetic gets DST
  transitions wrong by construction (a fixed offset assumption breaks the
  two days a year the offset actually changes), and reimplementing IANA
  timezone-database-aware rules ourselves is precisely the "worse,
  less-tested copy" CLAUDE.md's dependency bar warns against for a spec this
  deep.
- *`date-fns`/`date-fns-tz`* — comparable capability, but a more fragmented
  API surface (a base package plus a separate `-tz` package, with known
  version-compatibility friction between the two) for the same job `luxon`
  does as one cohesive library.
- *`dayjs`* — smaller core, but its timezone/UTC support is opt-in plugins
  layered onto a mutable-by-default API; `luxon`'s `DateTime` is immutable
  by design, which fits this package's "pure functions, no I/O" resolver
  style more directly.

**Constraints it creates:**

- `luxon` usage is scoped to `packages/google-calendar` only — no other
  package gains a reason to import it. Any future package needing
  timezone-aware date math re-justifies its own dependency rather than
  assuming this decision already covers it elsewhere.
- `relative-time.ts`'s public functions take and return plain ISO strings,
  never a `DateTime` instance — callers outside this package are never
  coupled to `luxon`'s API.
