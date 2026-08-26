import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError, LlmMalformedResponseError, LlmTimeoutError } from "../../errors";
import { MAX_TOKENS_PER_TURN } from "../../max-tokens";
import type { ProviderProfile } from "../../port";
import { createOpenAiCompatibleAdapter } from "../openai-compatible";

const PROFILE: ProviderProfile = {
  baseUrl: "https://provider.example/v1",
  apiKey: "sk-super-secret-key",
  model: "some-model",
};

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function validCompletionBody(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

function baseRequest() {
  return {
    model: PROFILE.model,
    system: "you are a helpful assistant",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [{ name: "noop", description: "does nothing", parameters: {} }],
    maxTokens: MAX_TOKENS_PER_TURN,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createOpenAiCompatibleAdapter — request shape", () => {
  it("posts to <baseUrl>/chat/completions with tools before messages, system as messages[0], and max_tokens set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });
    const request = baseRequest();

    await adapter.complete(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROFILE.baseUrl}/chat/completions`);

    const bodyText = init.body as string;
    const parsed = JSON.parse(bodyText);
    const keys = Object.keys(parsed);
    // OpenAI-compatible chat-completions APIs have no top-level `system`
    // field; the system prompt must be `messages[0]` with `role: "system"`
    // or providers silently drop it.
    expect(keys).not.toContain("system");
    expect(keys.indexOf("tools")).toBeLessThan(keys.indexOf("messages"));
    expect(parsed.messages[0]).toEqual({ role: "system", content: request.system });
    expect(parsed.messages.slice(1)).toEqual(request.messages);
    expect(parsed.max_tokens).toBe(MAX_TOKENS_PER_TURN);
  });

  it("sends the API key as a Bearer authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    await adapter.complete(baseRequest());

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PROFILE.apiKey}`);
  });
});

describe("createOpenAiCompatibleAdapter — success path", () => {
  it("parses text, usage, and finishReason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    const result = await adapter.complete(baseRequest());

    expect(result.text).toBe("hello there");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });
});

describe("createOpenAiCompatibleAdapter — 429 retry", () => {
  it("retries with backoff then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, false, 429))
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.text).toBe("hello there");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createOpenAiCompatibleAdapter — Retry-After honored on 429", () => {
  it("waits the Retry-After header's duration before retrying, not the computed backoff", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: "rate limited" }, false, 429, { "retry-after": "7" }),
        )
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      await resultPromise;

      // 7s from the header, not the ~1s the computed backoff would use for
      // attempt 1 — confirms the header value, not `nextDelay`'s default,
      // drove the wait.
      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 7_000,
      );
      expect(retryDelayCall).toBeDefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createOpenAiCompatibleAdapter — 5xx exhausts retries", () => {
  it("throws LlmHttpError after bounded retries", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, false, 503));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

      const resultPromise = adapter.complete(baseRequest()).then(
        () => {
          throw new Error("expected complete() to reject");
        },
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(LlmHttpError);
      expect((error as InstanceType<typeof LlmHttpError>).status).toBe(503);
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createOpenAiCompatibleAdapter — timeout", () => {
  it("throws LlmTimeoutError when the request exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      });
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl, timeoutMs: 1_000 });

      const resultPromise = adapter.complete(baseRequest()).then(
        () => {
          throw new Error("expected complete() to reject");
        },
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(LlmTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws LlmTimeoutError, not LlmMalformedResponseError, when the timeout fires while reading the body", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const response = {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
          text: async () => "",
        } as unknown as Response;
        return Promise.resolve(response);
      });
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl, timeoutMs: 1_000 });

      const resultPromise = adapter.complete(baseRequest()).then(
        () => {
          throw new Error("expected complete() to reject");
        },
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(LlmTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createOpenAiCompatibleAdapter — malformed responses", () => {
  it("throws LlmMalformedResponseError for a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
      text: async () => "not json",
    } as unknown as Response);
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });

  it("throws LlmMalformedResponseError, not a zero-usage success, when usage is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      }),
    );
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });
});

describe("createOpenAiCompatibleAdapter — API key redaction", () => {
  it("never surfaces the raw API key in a thrown error on an HTTP error response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: `bad key ${PROFILE.apiKey}` }, false, 401));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

    try {
      await adapter.complete(baseRequest());
      throw new Error("expected complete() to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(PROFILE.apiKey);
      expect(message).toContain("<REDACTED>");
    }
  });

  it("never surfaces the raw API key in a thrown error on a network failure", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockRejectedValue(new TypeError(`request with key ${PROFILE.apiKey} failed: ECONNRESET`));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { fetchImpl });

      const resultPromise = adapter.complete(baseRequest()).then(
        () => {
          throw new Error("expected complete() to reject");
        },
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await resultPromise;

      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(PROFILE.apiKey);
      expect(message).toContain("<REDACTED>");
    } finally {
      vi.useRealTimers();
    }
  });
});
