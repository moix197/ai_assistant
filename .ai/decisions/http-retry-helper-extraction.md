# One shared HTTP retry/backoff/timeout helper in `core`, extracted at the third caller

**Decision:** `packages/core/src/http-retry.ts`'s `withHttpRetry` owns attempt
sequencing, per-attempt timeout, signal composition, backoff and per-class
attempt bounds. `packages/llm`'s adapter and `packages/channels`' Telegram
client were migrated onto it with **no behavior change**; `packages/google-sheets`'
client was written against it from the start and has no retry code of its own.

**Why:**

- **Extracted at the third caller, not the second.** Two hand-rolled copies were
  tolerable; adding a third was the wrong direction. This is the one deliberate
  horizontal refactor in an otherwise vertical-slice plan.
- **The contract had to fit the union of both existing callers, not their
  intersection.** They genuinely differed in three ways, so the helper takes
  *caller-named* retry classes (`Record<TClassName, RetryClassConfig>`) rather
  than a fixed rateLimit/transient pair:
  1. **Class count 2 vs 3** — `channels` has a Telegram-only `conflict` class
     (HTTP 409, "another consumer is polling") with its own bound and its own
     exhausted-retries message; hence `RetryClassConfig.buildExhaustedError`.
  2. **`Retry-After` resolution** — `llm` falls back to a body-embedded
     `google.rpc.RetryInfo.retryDelay` because Google's API sends no header;
     `channels` has no such fallback. So the helper takes a caller-computed
     `retryAfterMs` on the classification result and never parses anything
     itself.
  3. **Signal composition** — `channels` deliberately avoided `AbortSignal.any`
     (Node 22 never releases a dependent signal from a composite it created;
     ~2.5KB leaked per ~30s long poll). The helper standardizes on the
     listener-based composition, so `llm` migrated its *implementation*, not just
     its call site — quietly closing the same latent leak on the LLM path.
- **Classification stays caller-owned, and that is what makes "preserves thrown
  error types" structural rather than merely tested.** `classify` receives the
  error and either names a class or **throws the caller's own typed error
  directly**. The helper never decides "this is a rate limit" and never
  constructs a typed error of its own. Redaction likewise stays caller-side —
  `withHttpRetry` never touches request or response content, so it can never
  leak a bot token or a bearer token into a message.
- **Verification is unchanged behavior, so it is proven by unchanged tests.**
  `llm`'s and `channels`' existing suites pass with no assertion changes; a red
  test there means the extraction changed behavior. The one exception is the
  signal-composition change in `llm`, whose new behavior (leak-safety) needed a
  new test because no existing assertion described it.

**Rejected:**

- *A fixed rateLimit/transient class pair* — cannot express `channels`' 409
  class without special-casing Telegram inside `core`.
- *Parsing `Retry-After` inside the helper* — would force Google's `RetryInfo`
  body fallback into `core` too, coupling a shared primitive to one provider's
  error envelope.
- *`AbortSignal.any` for composition* — the measured leak; see above.
- *Leaving Sheets to hand-roll a fourth copy* — the reason the extraction
  happened at all.

**Constraints it creates:**

- A new HTTP caller supplies `attempt`, `classify`, its class table and its own
  redaction. It does **not** add retry logic of its own.
- A non-retryable failure must be **thrown** from `attempt`/`classify`, never
  returned — there is no "fatal" class.
- Any change to `http-retry.ts` is a change to the LLM billing path and the
  Telegram poll loop simultaneously. Both suites are the regression net.
