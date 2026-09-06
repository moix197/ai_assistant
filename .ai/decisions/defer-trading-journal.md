# Defer Phase 4 (trading journal), build the connector phases first

**Decision:** Phase 4's trading-journal capability — the `trading-journal`
package, the `log_trade` / `update_trade` / `close_trade` / `query_trades`
tools, the column-mapping config, and locally-computed aggregates — is
deferred indefinitely. Phase 5 (Calendar) and Phase 6 (Gmail) are built next,
in parallel. The generic Sheets capability from `05-google-sheets.md` stays as
shipped; nothing is removed.

**Why:** The roadmap ordered the trading journal first because it was the
originally-stated goal, not because anything depends on it. Nothing in phases
5-10 imports from it. Priorities moved: Calendar and Gmail are wanted now and
the journal is not, so building it first would spend the project's next stretch
on a capability no one is waiting for.

Calendar and Gmail are also the cheapest capabilities left. Phase 3 already
shipped OAuth, token encryption, refresh, and the `/connect` flow, and
`google-sheets` established the shape a Google tool package takes — a thin REST
client plus approval-gated tools. Each new connector adds a scope, a client, and
its tools. They are genuinely parallel: they share only
`packages/google-auth/src/scopes.ts` and the tool registry.

**Rejected:**

- *Build Phase 4 first, as the roadmap says.* Roadmap order is a default, not a
  constraint, and this item blocks nothing.
- *Add WhatsApp (Phase 10) to the parallel batch.* It is a channel, not a tool —
  it changes how messages arrive, touching the channel port, dispatcher,
  allowlist, dedupe, and the Telegram-specific approval gate. Its mandatory
  `X-Hub-Signature-256` webhook verification needs the HTTP ingress and public
  hostname that **Phase 7** builds, so doing it now means smuggling Phase 7 into
  a WhatsApp PRD. Its long pole is Meta Business verification paperwork, which no
  PRD accelerates.
- *Delete the Phase 4 material from the roadmap.* Deferred is not cancelled; the
  roadmap section stays so the work is still specified if it is picked up.

**Constraints it creates:**

- `plans/ROADMAP.md` phase numbering no longer matches build order. Phase 4 stays
  in place, marked deferred, pointing here.
- Whoever picks Phase 4 up must re-read `05-google-sheets.md` for what was
  deliberately excluded — that plan is the authority on where the generic
  capability stops.
- Phase 10 stays blocked on Phase 7. If WhatsApp becomes urgent, Phase 7's
  ingress is the prerequisite to schedule, and the Meta paperwork should start
  well ahead of the code.
