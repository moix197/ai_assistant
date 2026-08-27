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

## The §8 measurement

Live run via `pnpm test:live`, 10 sequential trials per provider, one 5-tool
prompt, through the real adapter. Prompt: *"I'm about to pay a Japanese
supplier. Convert 250 US dollars to Japanese yen for me."* Expected tool:
`convert_currency`, offered alongside four others (`get_current_time`, `echo`,
`search_web`, `create_calendar_event`). `maxTokens` ladder: 8192 → 32768 →
65536. Denominators: accuracy over scorable trials, malformed-JSON over trials
that actually attempted a tool call.

| provider | model | accuracy | malformed-JSON | truncated | hard failures |
|---|---|---|---|---|---|
| primary / deepseek | `deepseek-v4-flash` | 10/10 (100%) | 0/10 (0%) | 0 | 0 |
| fallback / gemini | `gemini-3.6-flash` | **not measured** | — | — | — |

**The primary numbers are current.** `deepseek-chat`, the model the original
run measured, was retired by DeepSeek mid-plan — `GET /v1/models` on the live
key now returns only `deepseek-v4-flash`, `deepseek-v4-pro`,
`deepseek-v4-flash-vision-exp`, and `LLM_PRIMARY_MODEL` is `deepseek-v4-flash`.
The whole check was re-run against it. **Every `deepseek-chat` figure this
document used to carry is superseded and has been removed** — do not
resurrect it from git history to fill a gap; re-run the check instead.

**The fallback row is empty on purpose, and that is the honest state.** The same
re-run could not measure Gemini: 7 of 10 trials came back HTTP 429
`RESOURCE_EXHAUSTED` against the free tier's limit of 20. The 3 trials that did
complete were 3/3 clean, but 3 self-selected trials are not a measurement and
this document does not report a Gemini verdict from that run. **Gemini's
tool-calling quality is unmeasured on a live current run.** The standing
evidence is the tracked `gemini-3.6-flash` recordings under
`packages/llm/src/__tests__/live/fixtures/recorded/`, which were made against
the same model still configured today.

That asymmetry is why the primary fixtures were re-recorded against
`deepseek-v4-flash` and the fallback fixtures deliberately were **not**
(commit `b3669e5`): a stale primary recording was scoring a model no deployment
can reach, while the fallback recording still matches the configured model.
Overwriting the fallback fixtures with the quota-starved run would have
destroyed the only valid Gemini evidence in the repo.

## The contingency did not trigger

The native-Gemini-adapter branch is gated on a concrete numeric trigger. The
arithmetic, shown so nobody has to re-derive it:

- Gemini malformed-JSON 0% ≥ 20%? **no.** Gemini accuracy 100% ≤ 70%? **no.**
  → trigger **false**. Evaluated on the tracked `gemini-3.6-flash` recording,
  not on the quota-starved re-run.
- DeepSeek malformed-JSON 0% < 10%? **yes.** DeepSeek accuracy 100% ≥ 90%?
  **yes** — on `deepseek-v4-flash`, the model actually configured. → primary
  healthy, so there is no "Gemini-only problem" to contain.

**Consequence:** `packages/llm/src/adapter/gemini-native.ts` is not created. The
single OpenAI-compatible path serves both providers, which is the cheapest
possible outcome and the one the roadmap bet on. Nothing observed since
suggests reopening it — but the Gemini half of that verdict rests on a
recording, not on a live current run, so **a live Gemini re-measurement is the
first thing to do if tool calling ever misbehaves there.**

## Caveats — read these before citing the numbers

- **The first live run was invalid and measured nothing.** It returned HTTP 400
  on all 20 trials: the Phase 1 adapter never wrapped tool definitions in the
  OpenAI `{ type: "function", function: {...} }` envelope — it passed
  `body.tools = request.tools` straight through. A second, latent bug on the
  response side rejected `content: null`, which an OpenAI-compatible provider
  may return alongside `tool_calls`: the old adapter threw
  `LlmMalformedResponseError` on exactly that reply. It could **not** have
  produced a silent false trigger. `scoreTrial` books a thrown adapter error as
  an **infra** failure, never as a malformed-JSON trial; a run with no scorable
  trial leaves a
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
  20% / 70% thresholds could flip on one or two trials. A clean 100% / 0% is
  comfortably clear of the line, but this is a smoke check, not a benchmark.
  Do not quote it as a provider quality ranking.
- **A free-tier run is not guaranteed to produce a measurement at all.** The
  fallback profile's 10 trials fit inside the free-tier limit only if nothing
  else spent from the same quota that day; when they don't, the lane returns
  quota errors rather than trials, and the correct reading is *no data*, not a
  bad score. Budget the quota before re-running, and check the trial count
  before believing a fallback number.
- **The truncation ladder went unused.** `gemini-3.6-flash` is a reasoning model
  and the plan anticipated zero-content 200s with `finish_reason: "length"`;
  none occurred at 8192 `maxTokens`. The production per-turn guard is
  `MAX_TOKENS_PER_TURN = 1024`, which this check deliberately did **not**
  inherit — so the absence of truncation here does **not** prove 1024 is
  sufficient in production. That remains untested.

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
- The models measured are `deepseek-v4-flash` and `gemini-3.6-flash`, not the
  roadmap's directional `V4-Flash` / `Gemini Flash` labels. **Providers retire
  model ids without warning** — this document has already been invalidated once
  that way — so a stale id is a *breakage*, not just a mispricing:
  `packages/llm/src/pricing.ts` must carry a key for every configured
  `LLM_*_MODEL`, verified against the provider's live pricing page. See
  [llm-cost-accounting](llm-cost-accounting.md).
- **A tracked fixture is evidence only while it names a configured model.** The
  offline replay lane will happily keep scoring a retired model at 100% forever;
  nothing in the suite notices. On any model swap, re-record that provider's
  fixtures — and if the re-run fails to produce trials, leave the old ones and
  say so here rather than recording a void run over valid evidence.
- **The fallback is only usable while throttled because its retry hint is
  honored.** Gemini's 429s send no `Retry-After` and state a 27-53s delay in the
  error body instead; while the adapter read the header only, every bounded
  retry expired inside a window that could not have cleared — the designated
  fallback failed precisely when it was rate limited. The hint is still capped
  at `nextDelay`'s ceiling, so a longer ask is under-waited: quota must be
  budgeted before a fallback run, not retried through. See
  [index → Provider rate-limit backoff](../index.md#cross-cutting).
- **A rate limit is not a quality datum.** Failed trials classify as `infra`
  (429/5xx/network/timeout/abort) or `quality` (malformed response), and an
  infra-only run reports *could not be measured* instead of a score. Before that
  split every throw counted alike, and the quota-starved run above read as a
  Gemini **quality** failure — an infrastructure event nearly recorded here as a
  verdict about the model. Cite no fallback number without its infra count.
- The check is reproducible: `pnpm test:live` re-runs it, and the recorded
  responses are replayed offline by the default `pnpm test` lane. Re-run it
  before any provider swap; do not carry these numbers forward to a model this
  run never touched.
- §2.2's defensive machinery (schema validation, bounded retry, escalation tier)
  is **not** waived by this result. n=10 on one prompt sizes nothing; it only
  says the compatibility layer isn't the thing that will break first.
