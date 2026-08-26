import type { Logger } from "@hermes/core";
import type { ProviderProfile } from "@hermes/llm";
import type { Pool } from "@hermes/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlmProvider } from "../build-llm-provider";

const PROFILE: ProviderProfile = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-secret",
  model: "deepseek-v4-flash",
};

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockPool(): Pool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool & {
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

function baseRequest(model: string) {
  return {
    model,
    system: "you are a helpful assistant",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: undefined,
    maxTokens: 100,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildLlmProvider — boot wiring", () => {
  it("routes usage recording to @hermes/store's recordUsage against the real pool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ),
    );
    const pool = createMockPool();
    const provider = buildLlmProvider(pool, PROFILE, createMockLogger());

    await provider.complete(baseRequest(PROFILE.model));

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO llm_usage"),
      expect.arrayContaining([PROFILE.model]),
    );
  });

  it("wires the app's real logger through, not the adapter's no-op default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      ),
    );
    const pool = createMockPool();
    const logger = createMockLogger();
    const provider = buildLlmProvider(pool, { ...PROFILE, model: "some-retired-model" }, logger);

    await provider.complete(baseRequest("some-retired-model"));

    // resolveCostUsd's unknown-model warn only reaches a logger that was
    // actually passed through — the adapter's default is a no-op, so this
    // assertion fails silently (0 calls) if boot.ts stopped injecting the
    // real logger.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: "some-retired-model" }),
    );
  });
});
