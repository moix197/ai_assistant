# D4's multi-agent seam is one config object and a boundary rule — nothing else

**Decision:** The whole of ROADMAP D4 ("more than one agent, later") is reserved
by two things and no others: the `AgentDefinition` config object
(`packages/agent/src/types.ts` — `{ name, model, systemPrompt, tools, channels }`)
and the rule that `packages/agent` never imports a feature package. Tools are
built in `apps/hermes` and handed in already-constructed. No agent id exists in
the database, no manifest or registry is loaded, and exactly one
`AgentDefinition` is constructed in the repo (`apps/hermes/src/agent/build-agent.ts`,
`name: "hermes"`, tools `get_current_time` + `echo`).

**Why:**

- **The seam that is expensive to add later is the *boundary*, not the
  plumbing.** Once a tool's definition lives inside `packages/agent`, every
  later agent inherits it and the package is no longer agent-agnostic —
  untangling that is a refactor. By contrast a second agent's plumbing (a
  second `createAgent` call, a routing rule, an `agent_id` column) is
  additive work whose shape depends entirely on requirements that do not exist
  yet. So the boundary is enforced from day one and the plumbing is not built
  at all.
- **A config object is the cheapest thing that can hold the boundary.**
  `AgentDefinition` costs one interface and forces every agent-specific value
  (model, prompt, tools, channels) to be named in one place rather than read
  from module scope — which is what makes a second agent a construction-site
  change instead of a search-and-replace.
- **No mutable `register()`.** Tools are supplied once, at construction,
  because registration order would leak into the derived tool JSON schemas and
  therefore into the request prefix — the byte-stable prefix invariant is worth
  more than the convenience. See `assemblePrefix` in `packages/agent/src/prompt.ts`.
- **Speculative multi-agent scaffolding is exactly what D3 forbids.** An
  `agent_id` column nobody writes, a loader with one entry, a routing table with
  one row: structure that invites the wrong code and rots un-reviewed. See
  [d3-monorepo-package-per-concern](d3-monorepo-package-per-concern.md).

**Rejected:**

- *An `agent_id` column on `threads` now* — a migration for a dimension nothing
  can vary. `threads` is keyed `(channel, chat_id)`; adding the agent to that key
  is a decision about whether two agents share a conversation, which is the
  actual open question and cannot be answered by adding a column early.
- *A manifest / config-file loader for agent definitions* — a parser, a schema,
  and a failure mode, all to read one hardcoded object.
- *Letting `packages/agent` own the tools* — the one thing that would genuinely
  make a second agent expensive.

**Constraints it creates:**

- **`createAgent` takes one `AgentDefinition`, not a list.** Several comments in
  the source describe `apps/hermes` as passing "a single-entry
  `AgentDefinition[]`" — there is no array anywhere; `buildAgent` constructs a
  bare object. So agent #2 is a second `createAgent` call plus whatever decides
  which agent a message goes to, not a second list entry. Cheap, but not free —
  do not quote the "one more list entry" framing as if the list existed.
- **`AgentDefinition.channels` and `.name` are declared but effectively
  unread.** `runTurn` takes `channel` as a parameter and passes it straight to
  `ThreadRepo`; it never checks it against `definition.channels`. `name` is read
  only by `assertApprovalGateConfigured`'s error message. They are seam
  placeholders — the first code that routes by channel or agent has to give them
  meaning, and should not assume anything enforces them today.
- **A tool definition may never move into `packages/agent`.** That is the seam.
  A tool needing something only the app has (a channel handle, a pool, config)
  confirms the rule rather than justifying an exception — see how
  `ApprovalGate`/`ThreadRepo` are injected in
  [architecture](../architecture.md#dependency-direction).
- Adding the second agent means answering, in a new decision record: does it get
  its own thread history, its own budget line, and how does an inbound message
  choose between them. None of those are answered here.
