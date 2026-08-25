# Hermes — Roadmap

A self-hosted personal assistant you drive by texting it. Runs in Docker (local
today, any host later). Telegram is the control surface; Google Workspace is the
first set of hands; Slack and WhatsApp come later.

**Status:** planning. Nothing built. This document is the spine — each phase
below becomes its own PRD in `plans/` before implementation starts.

---

## 1. Product shape

**One sentence:** you text Hermes on Telegram, it reasons with Claude, and it
acts on your Google account on your behalf — with confirmation before anything
irreversible.

**Primary user:** you, single-tenant. No multi-user, no signup, no billing.
Every design decision may assume exactly one human. (Multi-tenancy is an
explicit non-goal; revisit only if this ever leaves your laptop.)

**Day-one jobs to be done:**

| Job | Example utterance | Phase |
| --- | ----------------- | ----- |
| Log a trade | "bought 100 AAPL @ 213.40, stop 209" | 4 |
| Query the journal | "how did I do this week?" | 4 |
| Check the day | "what's on tomorrow after 2?" | 5 |
| Schedule | "move my 3pm to Thursday" | 5 |
| Triage mail | "anything urgent in my inbox?" | 6 |
| Answer mail | "reply to Sarah, tell her Friday works" | 6 |
| Get told, not asked | morning digest arrives unprompted | 7 |

**Non-goals:** a web UI, a mobile app, voice, multi-user, autonomous action
without confirmation on anything that leaves the machine.

**Hard constraint: this must cost near-nothing to run.** Budget drives the model
choice, the architecture of `packages/llm`, and several invariants below. See
§2.1. Note this is *not* a general multi-provider gateway — it's one narrow port
with one adapter, sized to make swapping cheap providers a config change.

---

## 2. Stack decisions

| Decision | Choice | Why |
| -------- | ------ | --- |
| Runtime | Node 22 LTS + TypeScript (strict) | pnpm is the mandated package manager; native `fetch` is all the transport we need |
| Package manager | pnpm workspaces | per CLAUDE.md |
| **LLM access** | **One OpenAI-compatible HTTP adapter, model chosen by config string** | DeepSeek, Qwen/DashScope, Gemini, OpenRouter, and local Ollama/vLLM all speak this dialect. One adapter, zero lock-in, swap providers with an env var |
| **Model — primary** | **DeepSeek V4-Flash** | cheapest credible tool-calling; aggressive prefix caching. See §2.1 |
| **Model — fallback** | **Gemini Flash** (free tier for dev; paid tier as backup) | same OpenAI-compatible dialect → costs nothing extra to support |
| Agent loop | **ours** — ~200 lines in `packages/llm` + `packages/agent` | no vendor loop helper exists across providers; writing it is the price of portability, and it's the part we most want to control |
| Persistence | PostgreSQL 16 (docker-compose service) | real concurrency, JSONB for message history, `pgvector` available later for memory |
| Ingress | none until Phase 7, then `cloudflared` sidecar | Telegram long-polls; Google OAuth uses loopback. Free named tunnel needs a domain (~$10/yr) |
| Secrets | env vars → validated config at boot; OAuth tokens AES-256-GCM encrypted in Postgres | no plaintext refresh tokens at rest |
| Deployment | `docker compose up` | portable to any Docker host unchanged |

### 2.1 Cost strategy — the binding constraint

Budget is the hard constraint on this project. Everything below follows from it.

**Provider posture: rent nothing you can't swap.** We never import a vendor SDK.
`packages/llm` exposes one narrow port and one OpenAI-compatible adapter.
Changing provider is an env var, not a refactor. This matters more than usual
because cheap-model pricing and quality churn every few months — the winner today
is not the winner in six months, and the codebase must not care.

**Provider-agnosticism costs nothing, so we take it — but we don't build *for* it.**
DeepSeek and Gemini both speak OpenAI-compatible chat completions with tool
calling. Supporting both is one adapter and two config profiles, not two code
paths. What we explicitly do **not** build now: a provider registry, capability
negotiation, or per-provider feature flags. That's the "go crazy" version; it
waits until a third provider actually demands it.

**Config shape — a provider profile, not loose env vars.** Base URL, key, and
model ID must move together or you get mismatched-config failures that look like
model bugs:

```
LLM_PRIMARY_BASE_URL / _API_KEY / _MODEL      → DeepSeek V4-Flash
LLM_FALLBACK_BASE_URL / _API_KEY / _MODEL     → Gemini Flash
LLM_ESCALATION_MODEL                          → optional, on the primary
```

**Failover is manual in Phase 2.** Switching provider is a config change and a
restart. Automatic runtime failover is deliberately deferred, for two reasons:
it's ~30 lines once the port exists (so nothing is lost by waiting), and
**prefix caches are per-provider** — failing over mid-conversation discards the
DeepSeek cache and the next call back also misses. Casual failover is a cost
event, not a free safety net. Revisit once we know whether DeepSeek is actually
flaky in practice.

**One known risk:** Gemini's OpenAI-compatibility layer is not a perfect superset
of its native API. For our usage — chat completions plus tool calling — it is
expected to be fine, but if tool-calling behaviour there proves quirky, the fix
is a small native Gemini adapter behind the *same* port. Contained, and only if
it actually happens.

**Directional pricing (verify at signup — these move constantly):**

| Model | ~Input $/M | ~Output $/M | Note |
| ----- | ---------- | ----------- | ---- |
| Gemini Flash-family **free tier** | $0 | $0 | Rate-limited, low thousands of req/day. **Use this for all development** |
| Local Qwen via Ollama | $0 | $0 | Your electricity. Weakest tool-calling; good for offline dev |
| DeepSeek V4-Flash | ~$0.14 | ~$0.28 | Cache hits ~98% cheaper. Peak/off-peak billing introduced Aug 2026 — check current table |
| Gemini 3.5 Flash-Lite | ~$0.15 | ~$1.25 | Cheap input, pricier output |
| DeepSeek V4-Pro | ~$0.44 | ~$0.87 | Escalation tier only |
| _(Claude Opus 5, for scale)_ | _$5.00_ | _$25.00_ | _~35× DeepSeek input. Not used_ |

**What Hermes should actually cost.** Assume 50 turns/day, ~10k input tokens per
turn (system + tools + history), ~500 output. That's ~15M input / ~0.8M output a
month. On DeepSeek V4-Flash with prefix caching working, that lands in the
**low single-digit dollars per month**. The same workload on a frontier model
would be ~$80–100. The architecture below exists to keep it in the first bucket.

**Five cost levers, all designed in from Phase 2:**

1. **Prefix caching is not optional.** DeepSeek gives ~98% off cached input
   automatically — but only for a byte-stable prefix. Invariant #6 (stable
   `tools` → `system` → `history` ordering) is worth ~10× on the bill.
2. **Tiered routing.** Cheap model by default; escalate to a stronger model only
   for turns that fail a confidence/validation check. Configured per-tool, not
   guessed at runtime.
3. **Tool-set narrowing.** Don't ship 25 tool schemas on every turn. Register
   tools per-context (trading tools in a trading thread) — this cuts input
   tokens *and* raises tool-call accuracy on small models.
4. **Local pre/post-processing.** Aggregations, PnL math, date parsing, HTML→text
   all run in TypeScript. The model never reads 400 sheet rows to compute a
   win rate.
5. **Hard budget ceiling.** A monthly spend cap in Postgres. On breach: Hermes
   tells you and stops calling the API. Not a dashboard — a kill switch.

**Free-tier development discipline.** All Phase 0–6 development runs against
Gemini's free tier or local Ollama. The paid provider is not wired in until the
thing works. This makes the build itself cost $0.

### 2.2 The real cost of cheap models

Cheap models are worse at tool calling than frontier models. This is the actual
tax, and it must be engineered for rather than discovered:

- **Validate every tool argument with zod before executing.** Malformed tool JSON
  is normal on small models, not exceptional.
- **Retry with the error fed back.** One bounded retry loop with the validation
  error appended usually fixes it.
- **Cap loop iterations hard** (default 8). A confused small model will loop.
  A cap turns a runaway bill into an error message.
- **Prefer few, fat tools over many thin ones.** Small models pick wrong from
  large tool menus.
- **Own the conversation compaction.** No provider here offers server-side
  compaction. We roll older turns into a summary ourselves (Phase 8, with a
  crude token-count trim in Phase 2 as a stopgap).
- **Keep an eval fixture set** (§5, Phase 4 onward): ~30 recorded real
  utterances with expected tool calls. Swapping models becomes a 2-minute
  regression check instead of an act of faith.

### 2.3 Decisions taken

Settled. Each should get a file in `.ai/decisions/` when the relevant phase lands.

**D1 — No agent framework. Build the loop.** *(supersedes the earlier
Anthropic-SDK Tool Runner plan)*

Rejected LangChain/LangGraph and the Vercel `ai` SDK. LangGraph's genuine
offer — durable execution, Postgres checkpointing, `interrupt()` as our approval
gate — is real but loses on the project's binding constraint: DeepSeek prefix
caching requires a **byte-stable prefix**, and every framework injects, reorders,
or reformats messages between our code and the wire. We'd be fighting the
abstraction on the one thing that decides whether this costs $3/month or $30. It
also hurts debuggability precisely where cheap models fail (malformed tool JSON),
and LangGraph Platform — their deployment story — is a paid hosted product.

The Vercel `ai` SDK was the closer call: thinner, zod-native, `maxSteps` loop.
Rejected because it saves ~150 lines of `fetch` and nothing else — every hard
part (approval gate, budget kill switch, cost accounting, malformed-JSON retry,
cache-stable assembly) we build regardless. It exists to ease provider-swapping
in app code and to power streaming React UIs; we have one adapter shape covering
every candidate provider, and no UI.

*Escape hatch:* if the adapter becomes a time sink, or we need a provider that
isn't OpenAI-compatible, `ai` + `@ai-sdk/openai-compatible` is the fallback. Its
abstraction is thin enough that cache control stays reachable. Not the default.

**D2 — Observability is built from scratch, in its own package, in Phase 2.**
Not a debugging nicety — a **cost instrument**. Prefix caching cannot be tuned
and runaway loops cannot be caught without it, so it ships with the loop rather
than "later." Scope deliberately small: Postgres (already present) plus a
`/stats` Telegram command. Explicitly **not** Prometheus/Grafana/OTel containers
— that is more infrastructure than the agent itself. The event schema is shaped
so an OTel exporter can bolt on later without a rewrite.

**D3 — Monorepo, package per concern, created at its phase.** See §3.

**D5 — DeepSeek V4-Flash primary, Gemini Flash fallback, manual switching.**
Provider-agnosticism is taken because it's free — both speak OpenAI-compatible,
so it's one adapter and two config profiles, not two code paths. We do **not**
build a provider registry, capability negotiation, or automatic failover now;
working software first. Failover stays manual because prefix caches are
per-provider (switching discards them) and automating it later is ~30 lines once
the port exists. Known risk: Gemini's compatibility layer isn't a perfect
superset of its native API — if tool calling is quirky there, the contained fix
is a small native adapter behind the same port. See §2.1.

**D4 — Reserve the multi-agent seams in Phase 2; build nothing for them.**
The long-term aim is a pipeline that deploys agents easily, each potentially in
its own VM. That is **out of scope**, but the seams cost ~nothing now and are
expensive to retrofit. No framework helps here — LangChain is an agent *runtime*,
not a deployment pipeline. What actually makes agents deployable is: one image
with the agent selected by env var; an agent as a **declarative manifest** (tools,
channels, model, prompt) rather than bespoke wiring; shared infra packages; and
no global mutable state, with `agent_id` scoping in Postgres.

Concretely, in Phase 2: `agent` accepts an `AgentDefinition` object instead of
hardcoded wiring, and the tool registry is populated at boot from a list. Agent
#2 then becomes a config file, not a fork. Nothing more is built for this.

---

## 3. Package architecture

**Monorepo, pnpm workspaces.** One system with shared domain types — not
independent products. Separate repos would mean publishing to npm and
version-juggling to change the `Channel` interface. Atomic cross-package commits
matter here. (Monorepo ≠ one deployable: the build must stay able to emit lean
per-app images via `pnpm deploy --filter`, which is what makes "one agent per VM"
work later.)

**Package creation rule.** A concern that the roadmap knows will be separate is
created as its own package *in the phase where it first appears* — never grown
inside another package and extracted later. Merge-then-split costs more in both
the short and long term, and an unenforced boundary decays: code reaches across
it, and by extraction time there's no clean seam left, just entangled imports.
The module system is what makes the boundary real.

Corollary: don't scaffold Phase 7's packages in Phase 0 either. Create each at
its phase, then leave it alone.

Dependencies flow strictly downward. No package imports from a package above it.

```
apps/
  hermes/            thin entrypoint — wiring, boot, graceful shutdown. No logic.   [P0]

packages/
  core/              shared types, Result/error types, ids, clock,
                     logger port, telemetry recorder port                           [P0]
  config/            env schema + validation, fail-fast at boot                      [P0]
  store/             Postgres pool, migration runner, repositories                   [P0]
  channels/          Channel port + adapters: telegram/, (slack/, whatsapp/)         [P1]
  telemetry/         recorder implementation: LLM-call, tool-call and turn
                     events; cost rollups; /stats queries                            [P2]
  llm/               provider port + OpenAI-compatible adapter, retries, usage
                     accounting, budget ceiling. The ONLY package that talks
                     HTTP to a model provider                                        [P2]
  agent/             tool registry, prompt assembly, the agent loop, approvals,
                     compaction, tiered routing                                      [P2]
  google-auth/       OAuth2 flow, encrypted token store, refresh, scope registry     [P3]
  google-sheets/     thin Sheets REST client                                         [P4]
  trading-journal/   trade domain: schema, validation, PnL, sheet column mapping     [P4]
  google-calendar/   thin Calendar REST client                                       [P5]
  google-gmail/      thin Gmail REST client + MIME/HTML→text utilities               [P6]
  scheduler/         cron table in Postgres, job runner, at-least-once delivery      [P7]
  ingress/           HTTP server for webhooks                                        [P7]
```

**Boundary rules**

- `channels/*` know nothing about the model. They speak `InboundMessage` /
  `OutboundMessage` only.
- `agent` knows nothing about Telegram. It receives a normalized message and
  returns a normalized reply.
- `agent` knows nothing about *which provider* it's talking to. It depends on the
  `llm` port. No provider name, model string, or vendor-shaped type escapes
  `packages/llm`.
- **Nothing imports `telemetry` directly.** Packages depend on the recorder
  *port* in `core`; `apps/hermes` injects the implementation at boot. Importing
  the implementation would put a cycle through half the tree.
- `google-*` packages never import each other. Shared auth lives in
  `google-auth`, which they all depend on and which depends on none of them.
- `google-*` clients are dumb transport. Zero business logic — that lives in
  domain packages like `trading-journal`.
- Every capability is exposed to Claude as a **tool** registered by a feature
  package. `agent` never imports a feature package; features register into it.

---

## 4. Cross-cutting invariants

These hold from Phase 2 onward and every PRD must respect them.

1. **Allowlist first.** An inbound message from an unknown channel identity is
   dropped before it reaches the agent. No exceptions, no "unknown user" reply.
2. **Confirm before consequence.** Any tool that sends, deletes, spends, or
   mutates an external system requires an explicit in-chat confirmation. The
   agent may *propose* freely; it may not *act* silently.
3. **Every tool call is audited.** Tool name, arguments, result, latency, cost,
   and approval decision land in Postgres. Non-negotiable for a thing with
   access to your mailbox.
4. **Idempotency on writes.** Every external write carries a dedupe key so a
   retry can never double-append a trade or double-send a mail.
5. **Persist the full message shape, not strings.** History stores complete
   messages including `tool_calls` and `tool` result messages, in our own
   provider-neutral form. Storing only text breaks replay and makes provider
   swaps lossy.
6. **Cache-stable prompt ordering.** `tools` → `system` → `messages`, stable
   prefix, volatile content (timestamps, ids) last. A single moving byte near the
   front costs ~10× on DeepSeek. Verify via reported cache-hit token counts.
7. **Fail closed.** A tool that cannot verify it's safe to proceed errors out and
   reports; it does not guess.
8. **Validate tool arguments before executing.** Zod-parse every tool call.
   Invalid → feed the error back for one bounded retry → then fail loudly. Small
   models emit malformed JSON routinely; the loop must expect it.
9. **Every loop is bounded.** Max iterations, max tokens per turn, and a monthly
   spend ceiling. Breaching any of them stops the turn and messages you.

---

## 5. Phases

Each phase ends with something you can actually use. No phase depends on a
phase that comes after it.

---

### Phase 0 — Skeleton & runtime

Empty repo → a container that boots.

- pnpm workspace, TS strict, build (tsup), test (vitest), lint
- `docker-compose.yml`: `hermes` + `postgres`, named volume, healthchecks
- `config` package: typed env schema, fail-fast with a readable error
- `core`: logger, Result type, ids, clock
- `store`: pg pool, own migration runner (`NNN_name.sql`, tracked in a table)
- Graceful shutdown, `/health`

**Exit:** `docker compose up` → healthy, migrations applied, restart-clean.

---

### Phase 1 — Telegram control channel

You can text it and it answers. No AI yet.

- `Channel` port: `subscribe()`, `send()`, capability flags (markdown, files,
  buttons, max message length)
- Telegram adapter over raw `fetch` + `getUpdates` long-polling — no ingress,
  no library (the Bot API is a small REST surface; see dependency policy)
- Identity allowlist by Telegram user id
- Inbound normalization; outbound chunking at 4096 chars; typing indicator
- Offset persistence in Postgres, written **after** an update is fully handled.
  Telegram's `getUpdates` is **at-least-once, not exactly-once**: sending
  `offset = update_id + 1` acks and permanently deletes those updates
  server-side, so persisting the offset *before* handling loses them forever on
  a crash. Persisting after means a crash mid-handling replays one update —
  handlers must be idempotent. Duplicates are recoverable; losses are not.
- Single-instance constraint: Telegram allows only **one** concurrent
  `getUpdates` consumer per token (a second returns 409). The poller cannot be
  horizontally scaled — relevant to the per-VM deployment aim (D4), where each
  agent needs its own bot token
- `deleteWebhook` unconditionally at boot (cheap; required if one was ever set)
- Server-side queue retains unfetched updates for **24h**, then drops them

**Exit:** message the bot, get a deterministic echo. Kill the container
mid-conversation and restart: no update is lost, and any replayed update is
handled idempotently rather than double-processed.

---

### Phase 2 — LLM port + agent core

The brain, with throwaway tools. Largest phase; consider splitting the PRD in two.

**2a — `packages/llm` (provider layer)**

- Provider port: `complete({ model, system, messages, tools, maxTokens })` →
  `{ text, toolCalls, usage, finishReason }`. Provider-neutral types, ours.
- One OpenAI-compatible adapter over `fetch` (`/chat/completions`, `tools`,
  `tool_choice`). Covers DeepSeek, Qwen/DashScope, Gemini's compat endpoint,
  OpenRouter, and local Ollama with only a base URL + model string change.
- Retries with backoff on 429/5xx; typed errors; request timeout
- Usage accounting per call → Postgres, with cache-hit tokens tracked separately
  so we can *prove* caching is working
- **Budget ceiling**: monthly cap; on breach, calls throw a typed
  `BudgetExceededError` and Hermes tells you instead of spending
- Config: primary + fallback **provider profiles** (§2.1), validated at boot.
  Manual failover only — switch profile, restart. No automatic failover yet
- **First task of this phase:** run the DeepSeek-vs-Gemini tool-calling check
  (§8) against the real adapter. It sizes how much of §2.2's defensive machinery
  we actually need, and it's cheaper as the adapter's first test than as a
  throwaway script

**2b — `packages/telemetry` (the cost instrument)**

- Recorder port in `core`; implementation here; injected by `apps/hermes` at boot
- **LLM-call events**: model, input/output tokens, **cache-hit tokens tracked
  separately**, latency, dollar cost, thread + turn id
- **Tool-call events**: name, arguments, result, duration, approval decision, error
- **Turn events**: total cost, iterations used, outcome
- Cost rollups (today / this month / by tool) computed in SQL
- `/stats` Telegram command: spend, top tools, error rate, **cache hit rate**
- Event schema shaped for a later OTel exporter; no OTel dependency now

**2c — `packages/agent` (loop)**

- Accepts an `AgentDefinition` (tools, channels, model, prompt) rather than
  hardcoded wiring — the D4 seam. Registry populated at boot from a list
- Tool registry: zod schema → JSON Schema for the wire, handler, `requiresApproval`
- System prompt assembly with a byte-stable prefix
- **The loop:** call → validate tool args (zod) → approval gate → execute →
  append results → repeat, bounded at 8 iterations
- Bad tool args → one retry with the validation error fed back
- Parallel tool calls executed concurrently, all results returned together
- **Approval gate**: `requiresApproval` tools pause, send a Telegram confirm,
  then resume or refuse
- Crude context trim (drop-oldest with a token budget) — real summarizing
  compaction lands in Phase 8
- Tiered routing hook: per-tool/per-route model override
- Thread persistence: one thread per (channel, chat), full messages in JSONB
- Errors surface as a readable chat message, never a stack trace
- Two trivial tools to prove wiring: `get_current_time`, `echo`

**Exit:** real conversation over Telegram against **Gemini's free tier**, history
survives restart, an approval prompt actually blocks a tool, a `DEEPSEEK`-shaped
env swap changes provider with no code change, and `/stats` reports real spend
and cache hit rate.

---

### Phase 3 — Google identity

One OAuth foundation for all three Google services.

- `google-auth`: OAuth2 authorization-code flow with **loopback redirect**
  (installed-app style) — no public URL needed at this stage
- Scope registry: each service declares its scopes; incremental consent
- Encrypted token store (AES-256-GCM, key from env), automatic refresh with
  single-flight locking
- `/connect google` command in Telegram → link → callback → confirmation
- `/disconnect`, `/status` showing connected account + granted scopes
- Token-refresh failure → proactive Telegram alert, not a silent 401 loop

**Exit:** `/connect google`, then a `whoami` tool that returns your Gmail
address. Refresh works across a container restart.

---

### Phase 4 — Trading journal (Sheets) ⭐ first real capability

The thing you actually asked for.

- `google-sheets`: thin REST client (`values.get`, `values.append`,
  `values.batchUpdate`)
- `trading-journal`: trade schema (timestamp, symbol, side, quantity, entry,
  exit, stop, fees, PnL, strategy, notes), validation, derived PnL, and a
  **column-mapping config** so it adapts to your existing sheet rather than
  demanding a new one
- Tools: `log_trade`, `update_trade`, `close_trade`, `query_trades`
- Natural-language → structured trade parse, echoed back for confirmation
  before the row is written
- Dedupe key per trade so a retry can't double-append
- `query_trades` returns aggregates (win rate, R multiple, PnL by symbol/period)
  computed locally — not by making Claude read 400 rows

**Exit:** "bought 100 AAPL at 213.40, stop 209, momentum setup" → parsed →
confirmed → row in your sheet. "How did I do this week?" → real numbers.

---

### Phase 5 — Calendar

- `google-calendar`: thin REST client, correct timezone handling (store UTC,
  render in your zone)
- Read tools: `list_events`, `find_free_slot`, `check_availability`
- Write tools (approval-gated): `create_event`, `reschedule_event`,
  `cancel_event`
- Relative-time resolution ("tomorrow after 2", "next Thursday morning")

**Exit:** "what's on tomorrow?" and "move my 3pm to Thursday 10am" both work.

---

### Phase 6 — Gmail

Highest-risk phase. Read is cheap, send is irreversible.

- `google-gmail`: thin REST client; MIME parsing, HTML→text, quoted-reply
  stripping (own utilities — this is where mail bodies stop poisoning context)
- Read tools: `search_mail`, `list_unread`, `read_thread`, `summarize_inbox`
- Write tools: `draft_reply`, `send_draft`, `archive`, `label` — all
  approval-gated; **`send_draft` always requires explicit confirmation, with no
  "always allow" escape hatch**
- Body-size budget per message into context; long threads get summarized, not
  dumped
- Draft → you read it in Telegram → confirm or edit by replying

**Exit:** "anything urgent today?" gives a real triage. "Reply to Sarah, Friday
works" produces a draft you approve, then it sends.

---

### Phase 7 — Proactive & ingress

Hermes stops waiting for you.

- `ingress`: HTTP server (node:http) for webhooks
- `cloudflared` sidecar in compose → stable public HTTPS hostname
- `scheduler`: cron table in Postgres, job runner, at-least-once with
  idempotency keys, missed-run catch-up
- Gmail push via Pub/Sub `watch` → near-realtime instead of polling
- Calendar push notifications
- **Morning digest**: agenda + urgent mail + open positions, delivered unprompted
- Simple rules: "if mail from X arrives, ping me"

**Exit:** it messages you first, and it's useful when it does.

---

### Phase 8 — Memory

- Long-term fact store: preferences, contacts, your trading rules, broker fee
  structure, recurring context
- Retrieval into the system prompt (keeping the cache prefix stable)
- `pgvector` for semantic recall if keyword retrieval proves insufficient
- Context-editing / compaction tuning for very long threads

**Exit:** you stop repeating yourself.

---

### Phase 9 — Slack

- Slack adapter via **Socket Mode** (no public ingress required)
- Primarily a *source*: read channels/DMs, summarize, draft replies
- Optionally a second control surface

**Exit:** "what did I miss in #trading?" and approved replies.

---

### Phase 10 — WhatsApp Cloud API (Official)

Deliberately last. **Start the paperwork around Phase 4** — the approvals are
the long pole, not the code.

- Meta Business verification, verified phone number, Cloud API app
- Webhook verification + `X-Hub-Signature-256` validation (mandatory)
- 24-hour customer service window; proactive messages outside it require
  **pre-approved message templates** — this constrains what Phase 7 digests can
  do over WhatsApp
- Adapter behind the existing `Channel` port — if Phases 1–2 got the boundary
  right, this is an adapter and a webhook route, nothing more

**Exit:** same assistant, WhatsApp surface.

---

## 6. Dependency policy for this project

Per CLAUDE.md we build our own by default. The exception is narrow and
justified per package. Proposed baseline:

**Adopt (safe, large, stable, not disappearing):**

| Package | Why we don't build it |
| ------- | --------------------- |
| `zod` | Tool argument validation (invariant #8) + JSON Schema generation + env validation. Ubiquitous, zero deps |
| `pg` | Postgres wire protocol. Reimplementing it is absurd |
| `google-auth-library` | Google's own OAuth2 + token refresh + JWT signing. Crypto-adjacent, spec-heavy |
| `typescript`, `vitest`, `tsup` | Toolchain |

**Build our own:**

- **The LLM client and agent loop.** No vendor SDK — `fetch` against an
  OpenAI-compatible endpoint is ~150 lines and is what makes provider swaps free.
  Installing `openai` to talk to DeepSeek would put a vendor's type system at the
  centre of a deliberately vendor-neutral design
- Telegram Bot API client (small REST surface, and we want control of polling,
  chunking, and retries)
- Gmail / Calendar / Sheets REST wrappers (`fetch` + `google-auth-library` for
  tokens — we use ~15 endpoints, not the 400 in `googleapis`)
- Job scheduler / cron runner (Postgres-backed, ~200 lines, no new infra)
- Migration runner, HTTP router (`node:http`), logger wrapper

**Rejected:**

- `langchain` / `langgraph` — a large, fast-churning dep tree wrapped around the
  one component we most need to control (the loop, retries, and cost accounting),
  and its provider abstraction is heavier than the ~150-line one we need
- `openai` / `@google/generative-ai` / any vendor SDK — see above; a vendor type
  system at the centre of a vendor-neutral design
- `googleapis` — hundreds of MB of generated clients for a handful of endpoints
- `telegraf` / `grammy` — reasonable libraries, but the surface we need is small
  enough to own. (Escape hatch: if the polling/retry edge cases bite, `grammy`
  is the fallback.)
- `express` — `node:http` is sufficient for a handful of webhook routes

CLAUDE.md has been updated with the general form of this policy.

---

## 7. Risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Agent sends a wrong email | High, irreversible | Confirm-before-send with no bypass; draft-first always (Phase 6) |
| Google refresh token expires/revoked | Assistant goes dead silently | Proactive Telegram alert on refresh failure (Phase 3) |
| **Token cost runs away** | **Financial — the project's main constraint** | Hard monthly ceiling + kill switch, bounded loops, prefix caching, local pre/post-processing, free tier for all development (Phase 2) |
| **Cheap model calls tools badly** | **Quality — the main technical risk** | Zod validation + bounded retry, few fat tools, narrowed per-context tool sets, eval fixture set, escalation tier (Phase 2, §2.2) |
| **Provider dies, hikes prices, or degrades** | Rewrite risk | One OpenAI-compatible adapter behind a port; swap = env var. Never import a vendor SDK |
| DeepSeek peak/off-peak billing surprises the budget | Financial | Ceiling is enforced in dollars, not tokens; non-urgent scheduled jobs (Phase 7) run off-peak |
| Trade logged twice on retry | Corrupted journal | Idempotency keys on every external write (Phase 4) |
| Mail bodies flood context | Cost + quality collapse | Per-message body budget, HTML→text, quote stripping (Phase 6) |
| WhatsApp approval blocks the roadmap | Schedule | It's Phase 10 and behind a port; start paperwork at Phase 4 |
| Secrets in a local container | Security | Encrypted token store, allowlist, full audit log (Phases 2–3) |

---

## 8. Next step

Write a PRD per phase, in order, immediately before building that phase — not
all ten up front. Phases 0–2 are foundational and could reasonably be one PRD;
Phases 3–4 are the first real deliverable and deserve careful specs.

Suggested PRD order:

1. `plans/00-skeleton.md` — Phases 0 + 1 (skeleton through Telegram echo)
2. `plans/01-llm-port.md` — Phase 2a (provider port, adapter, budget ceiling)
3. `plans/02-telemetry.md` — Phase 2b (recorder, cost events, `/stats`)
4. `plans/03-agent-core.md` — Phase 2c (loop, tools, approvals, `AgentDefinition`)
5. `plans/04-google-auth.md` — Phase 3
6. `plans/05-trading-journal.md` — Phase 4
7. …then one per phase as you reach it

**On the DeepSeek-vs-Gemini check:** no longer a precondition — the primary is
decided (D5), and "get something working first" outranks benchmarking. It moves
*inside* Phase 2a as the adapter's first test: same 5-tool prompt against both
profiles, comparing tool-call accuracy and malformed-JSON rate. It still tells us
how much of §2.2's defensive machinery is warranted, but it now doubles as the
adapter's proof of life instead of being a throwaway script.

Each PRD declares its `## Knowledge Base Impact` and syncs `.ai/` at closeout,
per the `write-prd` / `execute-prd` workflow.
