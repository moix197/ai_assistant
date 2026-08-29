# Pattern: DB-backed tool configuration

An operator-editable table that a tool (or a group of tools) reads at
call-time, instead of a `.env` value or a boot-time constant. `sheet_registry`
(`05-google-sheets` Phase 3) is the first instance.

## The four rules

1. **A port is declared in the *consumer*, not the repo package.** The
   package that reads the config at tool-call time (`@hermes/google-sheets`)
   declares its own narrow interface
   (`SheetRegistryPort { getBySlug, listAll }`) — the same
   consumer-declares-its-port convention `GoogleAccountRepo` already uses.
   `@hermes/store` implements the repo functions; `apps/hermes` binds them to
   the port. The repo package never depends on its consumer.
2. **A typed table with real columns and a zod row parse, never a JSON
   blob.** Each config field is its own column with its own `CHECK`
   constraint where the value set is closed (e.g. `access`,
   `value_input_option`), and every read validates the row against a
   schema-first type declared in `@hermes/core` (`parseValidatedJson`, the
   same helper `thread-repo.ts`/`google-account-repo.ts` use) — not a
   hand-cast `any`. A `tool_config jsonb` catch-all column is exactly what
   this pattern exists to avoid: it defeats `CHECK` constraints, defeats
   `NOT NULL`, and turns every consumer into its own ad hoc validator.
3. **The config is read at tool-call time, never frozen into a boot-time
   closure or cache.** A registry snapshot taken at boot (or memoized after
   first read) goes stale the moment an operator edits a row — worse once a
   dashboard can edit it without a restart. Every tool invocation hits the
   pool directly through the port; there is deliberately no cache layer to
   invalidate.
4. **A CLI bin writes through the exact same repo functions a future
   dashboard will call.** `hermes-sheets` (`packages/store/bin/sheets.ts`) is
   a thin argument-parsing wrapper over `sheet-registry-repo.ts`'s `upsert`/
   `remove`/`listAll`/`getBySlug` — never a second write path. A dashboard
   added later calls the same functions, so the CLI and the dashboard can
   never disagree about what a valid row looks like.

Rule 3 has a second, less obvious consequence here: the tool arg that names a
config row stays `z.string()`, never a `z.enum` built from the table's current
contents — the enum's literals would ride in the tool's JSON Schema, which is
the cache-stable prompt prefix, so every operator edit would invalidate the
provider's cache. Validation happens in the handler against the live registry.
See [google-sheets-scope-and-registry](../decisions/google-sheets-scope-and-registry.md).

## What this pattern is not

**This pattern has one instance.** Do not extract a generic `ConfigRegistry<T>`
or a shared `db-backed-tool-config` package until a second real case exists —
per CLAUDE.md's no-speculative-abstraction rule. A second instance should
first be built by hand, following the four rules above; only once two real,
divergent-enough cases exist is it worth asking whether a shared abstraction
would actually simplify both, rather than force-fitting them to a shape
neither needed on its own.
