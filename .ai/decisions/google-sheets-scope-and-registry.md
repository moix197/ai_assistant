# Sheets access: one scope, slug-only identity, registry in Postgres

**Decision:** `@hermes/google-sheets` asks for exactly one incremental scope,
`https://www.googleapis.com/auth/spreadsheets` (`SHEETS_SCOPES`, requested
only via `/connect google sheets`, always alongside identity). A spreadsheet
is never named by id or URL in chat: the operator pre-registers it under a
short slug in the `sheet_registry` **Postgres table**, and every tool arg is
`{ sheet: "<slug>" }`.

**Why:**

- **No Drive scope.** Search-by-name would need `drive.readonly` — read access
  to *every* file in the account — to save the operator one registration step.
  `spreadsheets` alone still reaches any spreadsheet whose id we hold, so the
  registry is what actually bounds reach, not the scope.
- **Slugs, not ids, because the model must not be able to widen its own
  reach.** With a raw id or URL as a tool arg, any spreadsheet id the model can
  produce — hallucinated, or pasted earlier in a conversation — is reachable.
  With a slug, the set of reachable spreadsheets is exactly the set an operator
  typed into the registry, and an unknown slug returns
  `{ ok: false, reason: "unknown_sheet", available: [...] }` rather than an
  API call. Slugs also read better in an approval prompt than a 44-character
  id.
- **`z.string()`, not `z.enum(<current slugs>)`.** An enum built at boot bakes
  the registry's contents into the tool's JSON Schema — which is the
  cache-stable prefix (invariant 6), so every operator config edit would
  invalidate the provider's prompt cache — and goes stale the moment a row
  changes. Validation happens against the live registry inside the handler.
- **Postgres, not `.env` or a JSON file, because a dashboard is the intended
  editor.** A remote dashboard cannot edit a host `.env`, and a JSON blob is
  not row-editable. See [db-backed-tool-config](../patterns/db-backed-tool-config.md)
  for the four rules this implies (live read, typed columns, consumer-declared
  port, one write path shared with the CLI).
- **Primary key is `slug` alone, not `(channel, channel_user_id)`.** A
  registered sheet is operator configuration shared by every connected identity
  in this single-tenant deployment. Keying it per-user would model
  multi-tenancy the project explicitly does not have.

**Rejected:**

- *`drive.readonly` + search by name* — a much larger grant to buy convenience,
  in the phase that already grows the grant from "prove who you are" to "read
  and write every spreadsheet you own."
- *Accept a spreadsheet id/URL as a tool arg* — removes the only bound on what
  the agent can touch.
- *Registry in env or a config file* — not remotely editable, and a redeploy per
  edit.
- *A generic `tool_config` jsonb table or a `ConfigRegistry<T>`* — one instance
  exists; see the pattern doc's "what this pattern is not."

**Open — flagged for a human, not decided here:**

`plans/ROADMAP.md` §non-goals lists "a web UI" (and the surrounding text treats
a dashboard as out of scope). The registry is deliberately built to be
dashboard-editable. That line and this design are in tension and the tension is
real, not cosmetic. **This is not resolved by this plan** — it needs an explicit
call: either the non-goal narrows (no *end-user* web UI, an operator admin
surface is allowed) or the registry's Postgres-because-dashboard rationale
loses its main justification. Do not edit the ROADMAP line without that call.

**Constraints it creates:**

- Any future Google capability requests its own incremental scope through
  `/connect google <thing>` and declares it in `TOOL_REQUIRED_SCOPES`; nothing
  widens what a bare `/connect google` asks for.
- Every Sheets tool resolves its slug through `resolve-sheet.ts`'s
  `resolveSheet` — one lookup-and-branch, not a per-tool copy.
- `spreadsheets` is a *sensitive* scope: Google verification review becomes
  required if the app ever leaves Testing publishing status. Not solved here.
