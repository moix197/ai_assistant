# D5 — DeepSeek primary, Gemini fallback, manual switching (measured)

**Decision:** Unchanged from ROADMAP D5, and now backed by a live measurement
instead of an assumption. Both providers stay behind the **one**
OpenAI-compatible adapter (`packages/llm/src/adapter/openai-compatible.ts`);
DeepSeek is primary, Gemini is fallback, and switching between them is a config
change plus a restart. **No native Gemini adapter is built** — the contingency
that would have justified one did not fire.

The roadmap's original text, kept verbatim because the measurement confirms it
rather than replaces it:

> **D5 — DeepSeek V4-Flash primary, Gemini Flash fallback, manual switching.**
> Provider-agnosticism is taken because it's free — both speak OpenAI-compatible,
> so it's one adapter and two config profiles, not two code paths. We do **not**
> build a provider registry, capability negotiation, or automatic failover now;
> working software first. Failover stays manual because prefix caches are
> per-provider (switching discards them) and automating it later is ~30 lines once
> the port exists. Known risk: Gemini's compatibility layer isn't a perfect
> superset of its native API — if tool calling is quirky there, the contained fix
> is a small native adapter behind the same port. See §2.1.

## The measured result

Live run via `pnpm test:live`, 10 sequential trials per provider, the same
5-tool prompt, through the real adapter. Duration 128s.

Prompt: *"I'm about to pay a Japanese supplier. Convert 250 US dollars to
Japanese yen for me."* Expected tool: `convert_currency`, offered alongside four
others (`get_current_time`, `echo`, `search_web`, `create_calendar_event`).
`maxTokens` ladder: 8192 → 32768 → 65536.

| provider | model | accuracy | malformed-JSON | truncated | hard failures | bigger-budget re-runs |
|---|---|---|---|---|---|---|
| primary / deepseek | `deepseek-chat` | 10/10 (100%) | 0/10 (0%) | 0 | 0 | 0 |
| fallback / gemini | `gemini-3.6-flash` | 10/10 (100%) | 0/10 (0%) | 0 | 0 | 0 |

Denominators: accuracy over scorable trials; malformed-JSON over trials that
actually attempted a tool call.

## The contingency did not trigger

The native-Gemini-adapter branch is gated on a concrete numeric trigger. The
arithmetic, shown so nobody has to re-derive it:

- Gemini malformed-JSON 0% ≥ 20%? **no.** Gemini accuracy 100% ≤ 70%? **no.**
  → trigger **false**.
- DeepSeek malformed-JSON 0% < 10%? **yes.** DeepSeek accuracy 100% ≥ 90%?
  **yes.** → primary healthy, so there is no "Gemini-only problem" to contain.

**Consequence:** `packages/llm/src/adapter/gemini-native.ts` is not created. The
single OpenAI-compatible path serves both providers, which is the cheapest
possible outcome and the one the roadmap bet on.

## Caveats — read these before citing the numbers

- **The first live run was invalid and measured nothing.** It returned HTTP 400
  on all 20 trials: the Phase 1 adapter never wrapped tool definitions in the
  OpenAI `{ type: "function", function: {...} }` envelope — it passed
  `body.tools = request.tools` straight through. A second, latent bug on the
  response side rejected `content: null`, which an OpenAI-compatible provider
  may return alongside `tool_calls`: the old adapter threw
  `LlmMalformedResponseError` on exactly that reply. It could **not** have
  produced a silent false trigger. `scoreTrial` books a thrown adapter error as
  a **hard failure**, not as a malformed-JSON trial; hard failures leave a
  provider `comparable: false`, so the report would have printed
  `INVALID — NOT COMPARABLE` for it and the contingency `NOT EVALUATED`. The
  guards were built for this and would have caught it loudly. Its real blast
  radius was narrower still: DeepSeek returns non-null `content` alongside its
  `tool_calls` and never reaches that path, so the bug would have invalidated
  the Gemini half of the run and nothing else. Both were fixed
  before the run that produced the table above. Stated plainly: **the tool path
  had never been exercised against a real provider before this check**, despite
  Phase 1 being marked complete. A green unit suite did not mean a working
  adapter.
- **n = 10, one fixed prompt, one expected tool.** Roughly ±15pp of noise; the
  20% / 70% thresholds could flip on one or two trials. A result this clean
  (100% / 0% on both) is comfortably clear of the line, but this is a smoke
  check, not a benchmark. Do not quote it as a provider quality ranking.
- **The truncation ladder went unused.** `gemini-3.6-flash` is a reasoning model
  and the plan anticipated zero-content 200s with `finish_reason: "length"`;
  none occurred at 8192 `maxTokens`. The production per-turn guard is
  `MAX_TOKENS_PER_TURN = 1024`, which this check deliberately did **not**
  inherit — so the absence of truncation here does **not** prove 1024 is
  sufficient in production. That remains untested.
- **Rate-limit and backoff pressure are invisible in these columns.** They show
  up only as wall-clock (128s for 20 sequential calls).

**Rejected** (settled by the roadmap, and this check gives no reason to reopen
either):

- *Provider registry / capability negotiation / per-provider feature flags* —
  ROADMAP §2.1's "go crazy" version. Two providers behaving identically on the
  one dialect we use is the argument against building it; it waits until a third
  provider actually demands it.
- *Automatic runtime failover* — deferred, not forgotten. Prefix caches are
  per-provider, so failing over mid-conversation discards the DeepSeek cache and
  the call back also misses: failover is a cost event, not a free safety net.
  It's ~30 lines once the port exists, so nothing is lost by waiting. Failover in
  Phase 2a is **manual: edit the `LLM_*` env vars, restart.**
- *A native Gemini adapter* — see the arithmetic above. Rejected by measurement,
  not by preference.

**Constraints it creates:**

- Adding a provider means adding a profile (base URL + key + model, moved
  together), not a code path. Anything that can't be expressed that way is a
  signal to revisit D5, not to special-case the adapter.
- The models actually measured are `deepseek-chat` and `gemini-3.6-flash`, not
  the roadmap's directional `V4-Flash` / `Gemini Flash` labels. Model IDs are
  config, and the pricing table in ROADMAP §2.1 is explicitly directional —
  re-verify cost against the real IDs before relying on the budget estimate.
- The check is reproducible: `pnpm test:live` re-runs it, and the recorded
  responses are replayed offline by the default `pnpm test` lane. Re-run it
  before any provider swap; do not carry these numbers forward to a model this
  run never touched.
- §2.2's defensive machinery (schema validation, bounded retry, escalation tier)
  is **not** waived by this result. n=10 on one prompt sizes nothing; it only
  says the compatibility layer isn't the thing that will break first.
