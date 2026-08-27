/**
 * Invariant #6, live and unmissable — Phase 3's own labeled proof, not a
 * bullet buried in the usage-accounting list.
 *
 * **This suite spends real, billed money against the live DeepSeek primary
 * profile.** It runs only via `pnpm test:live`; the default lane excludes
 * `*.live.test.ts`.
 *
 * Two sequential real `complete()` calls sharing an identical `tools` +
 * `system` prefix, differing only in the trailing user message (matching
 * invariant #6's "volatile content last" rule and `buildRequestBody`'s own
 * `tools` -> `messages[0]` = system -> per-turn messages ordering). The
 * system prompt is padded well past DeepSeek's minimum cache block size so a
 * prefix cache hit is actually reachable on the second call. Asserts the
 * SECOND call's real, provider-reported `usage.cacheHitTokens` is greater
 * than zero and at least half of the first call's `promptTokens` — read from
 * the actual response, never inferred from the request JSON's shape.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleAdapter } from "../../adapter/openai-compatible";
import type { CompletionRequest, ToolDefinition } from "../../port";
import { resolveCostUsd } from "../../pricing";
import {
  type LiveProfiles,
  formatLiveSkipMessage,
  loadLiveProfiles,
  missingLiveEnvKeys,
} from "./setup";

const LIVE_TEST_TIMEOUT_MS = 5 * 60_000;

const missingEnvKeys = missingLiveEnvKeys();
const liveProfiles = loadLiveProfiles();
if (!liveProfiles) console.warn(formatLiveSkipMessage(missingEnvKeys));

/**
 * Repeated filler so the shared `tools` + system prefix comfortably exceeds
 * DeepSeek's minimum cache block size (documented around 64 tokens, but kept
 * far larger here for headroom) — this is prefix content, not a scored
 * prompt, so repetition is fine.
 */
const FILLER_SENTENCE =
  "This sentence exists only as stable filler content so the shared prompt " +
  "prefix comfortably exceeds the provider's minimum cache block size. ";
/**
 * Unique per run, and deliberately so. The prefix must be byte-identical
 * across the two calls *within* a run, but must differ *between* runs: a
 * literally constant prefix stays warm in the provider's cache once any run
 * has populated it, so every later run reports a cache hit on the FIRST call
 * too and the cold→warm transition this test exists to prove becomes
 * unobservable. Seeding the prefix guarantees call one is a genuine cache
 * miss.
 */
const RUN_SEED = randomUUID();

/**
 * `buildRequestBody` (see `../../adapter/openai-compatible.ts`) constructs
 * the outgoing JSON body by inserting keys in this order: `model`, then
 * `tools` (each serialized `{type, function: {name, description,
 * parameters}}`), then `messages` (system message first), then
 * `max_tokens`. `JSON.stringify` preserves object-key insertion order, so
 * `tools` — and within it, each tool's `description` — appears on the wire
 * *before* the system prompt (`messages[0]`), not after. Putting `RUN_SEED`
 * at the very start of the tool's `description` therefore minimizes the
 * amount of genuinely constant (seed-free) content ahead of it to just the
 * JSON scaffolding and the tool's `name` — safely under DeepSeek's 64-token
 * cache granularity even if that constant scaffolding grows. Seeding only
 * the system prompt (the previous approach) put ~60-70 constant tokens
 * (JSON scaffolding + the whole unseeded tool block) ahead of the seed,
 * which is what made this flaky in the first place.
 */
const STABLE_SYSTEM_PROMPT = `You are a terse assistant used only for a cache-hit token measurement (run ${RUN_SEED}). Reply with a single short word and nothing else. ${FILLER_SENTENCE.repeat(120)}`;

const SHARED_TOOLS: ToolDefinition[] = [
  {
    name: "noop",
    description: `(run ${RUN_SEED}) A tool that does nothing, offered only to keep the request shape stable across both calls.`,
    parameters: { type: "object", properties: {} },
  },
];

function buildRequest(model: string, userMessage: string): CompletionRequest {
  return {
    model,
    system: STABLE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: SHARED_TOOLS,
    maxTokens: 64,
  };
}

describe.skipIf(!liveProfiles)("invariant #6 — DeepSeek prefix cache-hit tokens, live", () => {
  it(
    "reports a cold first call and a nonzero, meaningful cacheHitTokens count on the second",
    async () => {
      // Safe: describe.skipIf above guarantees the profiles resolved.
      const profiles = liveProfiles as LiveProfiles;
      const profile = profiles.primary;
      // `usageRepo`/`budget` are mandatory adapter options (Phase 4 gap
      // fix); this live check pays real provider cost by design and isn't
      // exercising usage accounting or the budget ceiling, so a permissive
      // no-op stands in for both.
      const adapter = createOpenAiCompatibleAdapter(profile, {
        usageRepo: { recordUsage: async () => {} },
        budget: { usageRepo: { sumCostSince: async () => 0 }, capUsd: Number.POSITIVE_INFINITY },
      });

      const first = await adapter.complete(
        buildRequest(profile.model, "Reply with the word: one."),
      );
      const second = await adapter.complete(
        buildRequest(profile.model, "Reply with the word: two."),
      );

      const firstCostUsd = resolveCostUsd(profile.model, first.usage);
      const secondCostUsd = resolveCostUsd(profile.model, second.usage);

      console.log("first call usage:", first.usage, "cost usd:", firstCostUsd);
      console.log("second call usage:", second.usage, "cost usd:", secondCostUsd);

      // The run-seeded prefix has never been sent before, so call one must
      // miss outright. Without this the next two assertions would also pass
      // against a prefix already warmed by an earlier run, proving nothing.
      expect(first.usage.cacheHitTokens).toBe(0);
      expect(second.usage.cacheHitTokens).toBeGreaterThan(0);
      expect(second.usage.cacheHitTokens).toBeGreaterThanOrEqual(first.usage.promptTokens * 0.5);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
