import type { Env } from "@hermes/config";
import type { Logger } from "@hermes/core";
import { BudgetExceededError } from "@hermes/llm";
import type { ProviderProfile } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlmProvider } from "../build-llm-provider";

const PROFILE: ProviderProfile = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret",
  model: "deepseek-v4-flash",
};

const ENV: Env = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hermes",
  PORT: 3000,
  LOG_LEVEL: "info",
  TELEGRAM_BOT_TOKEN: "123456:FAKE-TOKEN-abcDEF",
  TELEGRAM_ALLOWLIST: "",
  LLM_PRIMARY_BASE_URL: "https://primary.example/v1",
  LLM_PRIMARY_API_KEY: "primary-key",
  LLM_PRIMARY_MODEL: "primary-model",
  LLM_MONTHLY_BUDGET_USD: 100,
  OAUTH_REDIRECT_BASE_URL: "http://localhost:3000",
};

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** `rows` seeds every `pool.query` call — the budget check's `SELECT SUM` included. */
function createMockPool(rows: unknown[] = []): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool & {
    query: ReturnType<typeof vi.fn>;
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubSuccessfulFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ),
  );
}

function baseRequest(model: string) {
  return {
    model,
    system: "you are a helpful assistant",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: undefined,
    maxTokens: 100,
    threadId: null,
    turnId: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildLlmProvider — boot wiring", () => {
  it("routes usage recording to @hermes/store's recordUsage against the real pool", async () => {
    stubSuccessfulFetch();
    const pool = createMockPool();
    const provider = buildLlmProvider(pool, PROFILE, createMockLogger(), ENV);

    await provider.complete(baseRequest(PROFILE.model));

    // Two calls: the budget check's SELECT SUM (before the fetch) and the
    // usage-recording INSERT (after it) — both against the same real pool.
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO llm_usage"),
      expect.arrayContaining([PROFILE.model]),
    );
  });

  it("wires the app's real logger through, not the adapter's no-op default", async () => {
    stubSuccessfulFetch();
    const pool = createMockPool();
    // First query is the budget check (rows: []), second is the usage INSERT.
    pool.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("db down"));
    const logger = createMockLogger();
    const provider = buildLlmProvider(pool, PROFILE, logger, ENV);

    await provider.complete(baseRequest(PROFILE.model));

    // recordCompletionUsage's insert-failure log only reaches a logger that
    // was actually passed through — the adapter's default is a no-op, so this
    // assertion fails silently (0 calls) if boot.ts stopped injecting the
    // real logger. (Previously pinned via resolveCostUsd's unknown-model
    // warn, removed by Phase 4's throw-instead-of-$0 reversal.)
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: PROFILE.model, error: "db down" }),
    );
  });
});

describe("buildLlmProvider — budget wiring", () => {
  // Pins the wiring this gap was reopened over: `boot.ts` used to call
  // `createOpenAiCompatibleAdapter` with no `budget` at all, so the real bot
  // enforced no ceiling. This asserts `resolveBudgetCapUsd(env)` and
  // `sumCostSince(pool, ...)` are actually threaded through, not just
  // present in the type — a regression back to "no budget" would make this
  // fail rather than silently pass.
  it("sums spend via @hermes/store's sumCostSince against the real pool and rejects before any fetch once the configured cap is met", async () => {
    stubSuccessfulFetch();
    const pool = createMockPool([{ total: "100" }]); // already at ENV's 100 USD cap
    const provider = buildLlmProvider(pool, PROFILE, createMockLogger(), ENV);

    await expect(provider.complete(baseRequest(PROFILE.model))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SUM(cost_usd)"),
      expect.any(Array),
    );
    // The rejected call must not be recorded as spend — only the budget
    // check's SELECT ran, never the usage INSERT.
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO llm_usage"),
      expect.anything(),
    );
  });

  it("proceeds when spend recorded in the real pool is under the configured cap", async () => {
    stubSuccessfulFetch();
    const pool = createMockPool([{ total: "1" }]); // well under ENV's 100 USD cap
    const provider = buildLlmProvider(pool, PROFILE, createMockLogger(), ENV);

    await expect(provider.complete(baseRequest(PROFILE.model))).resolves.toBeDefined();

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("buildLlmProvider — telemetry wiring", () => {
  // Pins the wiring this gap was reopened over (see plans/02-telemetry.md):
  // the recorder is optional at the adapter level, which is exactly the
  // shape that let `usageRepo`/`dedupeRepo` silently go unwired before.
  // Deleting the one line in `build-llm-provider.ts` that passes `recorder`
  // through must fail this test, not merely ship a feature no one notices
  // missing.
  it("passes a supplied recorder through to the constructed adapter's options", async () => {
    stubSuccessfulFetch();
    const pool = createMockPool();
    const recorder = { record: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
    const provider = buildLlmProvider(pool, PROFILE, createMockLogger(), ENV, undefined, recorder);

    await provider.complete(baseRequest(PROFILE.model));

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ name: "llm.call", model: PROFILE.model }),
    );
  });
});
