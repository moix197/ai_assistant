# Gmail scopes: two `/connect` tiers, flat literal requirements, no implication graph

**Decision:** `@hermes/google-auth`'s `scopes.ts` splits Gmail into two
incremental-consent tiers, each its own `/connect google` sub-argument:
`"gmail"` grants identity + `GMAIL_READ_SCOPES` (`gmail.readonly`) alone;
`"gmail-send"` grants identity + `GMAIL_READ_SCOPES` + `GMAIL_WRITE_SCOPES`
(`gmail.modify`, `gmail.send`) — deliberately re-requesting `gmail.readonly`
even though `gmail.modify` functionally implies read. `TOOL_REQUIRED_SCOPES`
stays flat and literal: each Gmail tool row lists the exact scope(s) it needs
(`gmail_archive`/`gmail_label`/`gmail_draft_reply` → `gmail.modify` only;
`gmail_send_draft` → `gmail.send` only), never the whole tier, and
`hasRequiredScopes` is plain string-containment with no scope-implication
table.

**Why:**

- **A read-only connection must never implicitly grant send.** Two tiers is
  the structural guarantee: a user who has only run `/connect google gmail`
  has an account row whose granted scopes contain `gmail.readonly` and
  nothing else, so no Gmail write or send tool can pass `withRequiredScopes`
  regardless of what the model asks for.
- **Re-requesting `gmail.readonly` in the send tier is intentional
  redundancy, not an oversight.** `hasRequiredScopes` does plain array
  containment (settled decision 1) — there is no logic anywhere that would
  let a granted `gmail.modify` stand in for a required `gmail.readonly`. If
  the send tier didn't also ask for read, the three read tools would be
  unreachable for a gmail-send-only connection even though `gmail.modify`
  can read a message body just fine via the API. The plan's Dependencies &
  Risks section names the contingency: if Google ever normalizes the
  combined OAuth consent screen down to granting one deduplicated scope
  string instead of the two requested, this redundancy becomes moot, not
  broken.
- **`TOOL_REQUIRED_SCOPES` stays flat and literal on purpose.** A tool
  declares the minimum scope it actually needs (`gmail_archive` needs
  `gmail.modify`, not the whole `GMAIL_WRITE_SCOPES` tier that also contains
  `gmail.send`), so a scope-implication graph (e.g. "modify implies read")
  would only ever be used to loosen an already-correct per-tool declaration,
  never to tighten one — a decision that saves nothing and adds a second
  place a scope requirement could silently drift from the tool that reads
  it.
- **This structurally guarantees a two-tier split only through Phase 2.**
  Once Phase 3 lands `gmail_archive`/`gmail_label` on `gmail.modify`, the
  send tier's scopes let a connected account read, archive and label without
  ever having sent anything — the "read tier can't write" guarantee holds,
  but "gmail-send tier" is no longer a pure superset reserved for sending;
  it is the superset tier for every Gmail mutation, sending included. This
  plan accepts that naming drift rather than adding a third tier (see
  Rejected).

**Restricted-scope prerequisite:** `gmail.readonly`, `gmail.modify` and
`gmail.send` are Google **Restricted** scopes (a step up from Sheets'
`spreadsheets`, which is merely *sensitive*) — publishing beyond Testing
status requires both Google's app verification review and an annual CASA
third-party security assessment. Not solved here; recorded so it isn't
rediscovered mid-launch the way `spreadsheets`' sensitive-scope status was
in `google-sheets-scope-and-registry.md`.

**Rejected:**

- *One combined tier (`/connect google gmail` grants read+write+send at
  once).* Defeats the whole point — a user who only ever wanted the bot to
  triage their inbox would be asked to also grant it the ability to send
  mail as them.
- *Three tiers (read / modify / send, each separate).* Considered given
  `gmail_archive`/`gmail_label` only need `modify` and `gmail_send_draft`
  only needs `send` — but a third `/connect` sub-command buys no real
  independence: nothing in this plan's tool set needs `modify` without also
  eventually wanting `send` reachable in the same connected session, and a
  third consent screen is one more thing for the user to reason about for a
  distinction `TOOL_REQUIRED_SCOPES` already enforces at the tool level.
- *Scope-implication logic in `hasRequiredScopes` (e.g. treat `gmail.modify`
  as satisfying a `gmail.readonly` requirement).* Would let a per-tool
  declaration silently loosen based on a hardcoded implication table
  maintained separately from Google's own scope semantics — exactly the
  "inferred at call time" posture `TOOL_REQUIRED_SCOPES`'s own doc comment
  already rejects for Sheets and Calendar.

**Constraints it creates:**

- A new Gmail tool declares the exact scope(s) it needs in
  `TOOL_REQUIRED_SCOPES`, never the whole tier constant.
- `resolveConnectScopes("gmail-send")` must keep including
  `GMAIL_READ_SCOPES` even if every current write tool only checks
  `gmail.modify`/`gmail.send` — removing it would make the three read tools
  unreachable for a send-tier-only connection.
- Do not add scope-implication logic to `hasRequiredScopes`; a tool that
  needs a broader scope than another tool's tier grants must request its own
  incremental consent.
