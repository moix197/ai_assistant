import type { Message } from "@hermes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError, LlmMalformedResponseError, LlmTimeoutError } from "../../errors";
import { MAX_TOKENS_PER_TURN } from "../../max-tokens";
import type { ProviderProfile } from "../../port";
import {
  type OpenAiCompatibleAdapterOptions,
  createOpenAiCompatibleAdapter,
} from "../openai-compatible";

// Model must be a real `MODEL_PRICING` entry: these tests exercise unrelated
// request/response behavior, but every successful `complete()` now resolves
// cost unconditionally (Phase 4: `resolveCostUsd` throws `UnpricedModelError`
// on an unpriced id instead of warning and returning $0).
const PROFILE: ProviderProfile = {
  baseUrl: "https://provider.example/v1",
  apiKey: "sk-super-secret-key",
  model: "deepseek-v4-flash",
};

// `usageRepo`/`budget` are mandatory adapter options (Phase 4 gap fix: an
// optional-with-a-silent-default budget/usageRepo let a call site bypass the
// ceiling without anyone noticing). This file's tests exercise unrelated
// request/response behavior, so they wire a no-op usage repo and a cap no
// real test spend could ever reach, rather than relying on a default.
const PERMISSIVE_OPTS: Pick<OpenAiCompatibleAdapterOptions, "usageRepo" | "budget"> = {
  usageRepo: { recordUsage: async () => {} },
  budget: { usageRepo: { sumCostSince: async () => 0 }, capUsd: Number.POSITIVE_INFINITY },
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
    threadId: null,
    turnId: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createOpenAiCompatibleAdapter — request shape", () => {
  it("posts to <baseUrl>/chat/completions with tools before messages, system as messages[0], and max_tokens set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
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
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    await adapter.complete(baseRequest());

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PROFILE.apiKey}`);
  });
});

/**
 * The wire format that shipped broken in Phase 1: tool definitions were POSTed
 * as the port's bare `{name, description, parameters}`, and both live providers
 * rejected every call with HTTP 400 — DeepSeek "tools[0]: missing field
 * `type`", Gemini "Unknown name \"name\" at 'tools[0]'". These assertions pin
 * the envelope literally so it cannot regress unnoticed again.
 */
describe("createOpenAiCompatibleAdapter — tool wire format", () => {
  const TOOLS = [
    {
      name: "convert_currency",
      description: "Convert money between currencies.",
      parameters: {
        type: "object",
        properties: { amount: { type: "number" }, to: { type: "string" } },
        required: ["amount", "to"],
      },
    },
    {
      name: "echo",
      description: "Repeat text back.",
      parameters: { type: "object", properties: {} },
    },
  ];

  async function postedBody(tools: typeof TOOLS | undefined) {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    await adapter.complete({ ...baseRequest(), tools });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it("wraps every tool in the OpenAI {type:'function', function:{...}} envelope", async () => {
    const parsed = await postedBody(TOOLS);

    expect(parsed.tools[0]).toEqual({
      type: "function",
      function: {
        name: "convert_currency",
        description: "Convert money between currencies.",
        parameters: {
          type: "object",
          properties: { amount: { type: "number" }, to: { type: "string" } },
          required: ["amount", "to"],
        },
      },
    });
    expect(parsed.tools).toEqual(
      TOOLS.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    );
  });

  it("nests name/description/parameters under `function`, never at the tool's top level", async () => {
    const parsed = await postedBody(TOOLS);

    for (const tool of parsed.tools) {
      expect(Object.keys(tool)).toEqual(["type", "function"]);
      expect(tool.type).toBe("function");
      expect(Object.keys(tool.function)).toEqual(["name", "description", "parameters"]);
    }
  });

  it("omits `tools` entirely when the request declares none", async () => {
    const parsed = await postedBody(undefined);

    expect(Object.keys(parsed)).not.toContain("tools");
  });
});

/**
 * The response half of the same never-exercised tool path. An OpenAI-compatible
 * provider answers a tool call with `content: null` — the tool call *is* the
 * message — so a strict `typeof content === "string"` check would turn every
 * successful tool call into an `LlmMalformedResponseError`.
 */
describe("createOpenAiCompatibleAdapter — tool-call responses", () => {
  function toolCallBody(args: string) {
    return validCompletionBody({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "convert_currency", arguments: args },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  }

  it("parses tool_calls[].function name and arguments into the port's ToolCall shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(toolCallBody('{"amount":250,"from":"USD","to":"JPY"}')));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    const result = await adapter.complete(baseRequest());

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "convert_currency",
        arguments: { amount: 250, from: "USD", to: "JPY" },
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("returns empty text rather than throwing when a tool call comes back with content: null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(toolCallBody("{}")));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    const result = await adapter.complete(baseRequest());

    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("still throws LlmMalformedResponseError when neither content nor a tool call is present", async () => {
    // The truncation signal the §8 scoring module relies on: HTTP 200,
    // `finish_reason: "length"`, nothing usable in the message.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        validCompletionBody({
          choices: [{ message: { content: null }, finish_reason: "length" }],
        }),
      ),
    );
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });
});

/**
 * The wire format that shipped broken in Phase 2's first cut: `buildRequestBody`
 * spread `request.messages` verbatim, so the domain's `toolCallId` (and an
 * assistant tool-call request, which had no representation at all) went over
 * the wire unchanged instead of as `tool_call_id`/`tool_calls` — every
 * OpenAI-compatible provider 400s that shape. These assertions pin the real
 * wire keys and message order so it cannot regress unnoticed again.
 */
describe("createOpenAiCompatibleAdapter — tool-call message wire format", () => {
  it("maps an assistant tool-call message to `tool_calls` and a tool-result message to `tool_call_id`/`role: 'tool'`, in that order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    const messages: Message[] = [
      { role: "user", content: "convert 100 usd to jpy" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "convert_currency", arguments: { amount: 100, to: "JPY" } }],
      },
      { role: "tool", content: "15000 JPY", toolCallId: "call_1" },
    ];

    await adapter.complete({ ...baseRequest(), messages });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);

    // messages[0] is the system prompt; the domain messages follow in order.
    const [, userMsg, assistantMsg, toolMsg] = parsed.messages;
    expect(userMsg).toEqual({ role: "user", content: "convert 100 usd to jpy" });
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "convert_currency", arguments: JSON.stringify({ amount: 100, to: "JPY" }) },
        },
      ],
    });
    expect(assistantMsg.toolCallId).toBeUndefined();
    expect(toolMsg).toEqual({ role: "tool", content: "15000 JPY", tool_call_id: "call_1" });
    expect(toolMsg.toolCallId).toBeUndefined();

    // The assistant's tool-call request must precede the result answering it.
    const assistantIndex = parsed.messages.indexOf(assistantMsg);
    const toolIndex = parsed.messages.indexOf(toolMsg);
    expect(assistantIndex).toBeLessThan(toolIndex);
  });

  it("serializes a plain assistant/user message with no tool calls unchanged, just role/content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    const messages: Message[] = [{ role: "assistant", content: "an earlier reply" }];

    await adapter.complete({ ...baseRequest(), messages });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);

    expect(parsed.messages[1]).toEqual({ role: "assistant", content: "an earlier reply" });
  });
});

describe("createOpenAiCompatibleAdapter — success path", () => {
  it("parses text, usage, and finishReason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validCompletionBody()));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    const result = await adapter.complete(baseRequest());

    expect(result.text).toBe("hello there");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheHitTokens: 0,
    });
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
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

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
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
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

/**
 * Google's Generative Language API never sends a `Retry-After` header on a
 * 429 — a live probe confirmed `retry-after: null` — but its JSON body
 * carries the same hint as a `google.rpc.RetryInfo` detail instead. Without
 * this fallback the adapter falls through to computed backoff (capped well
 * under what the provider actually asked for), burning every bounded retry
 * inside a rate-limit window that cannot have cleared.
 */
describe("createOpenAiCompatibleAdapter — RetryInfo body honored when Retry-After is absent", () => {
  function geminiRateLimitBody(retryDelay: string) {
    return {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded for metric generativelanguage.googleapis.com/...",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }],
      },
    };
  }

  it("waits the body's RetryInfo.retryDelay when no Retry-After header is present", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(geminiRateLimitBody("26.6s"), false, 429))
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      await resultPromise;

      // 26.6s from the body, not the ~1s the computed backoff would use for
      // attempt 1.
      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 26_600,
      );
      expect(retryDelayCall).toBeDefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a RetryInfo delay that exceeds the shared backoff ceiling, same as an oversized header value", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(geminiRateLimitBody("53s"), false, 429))
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      await resultPromise;

      // `nextDelay`'s MAX_DELAY_MS (30s) ceiling applies to a body-sourced
      // hint exactly as it does to a header-sourced one — no separate cap.
      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 30_000,
      );
      expect(retryDelayCall).toBeDefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the Retry-After header over the body's RetryInfo when both are present", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(geminiRateLimitBody("26.6s"), false, 429, { "retry-after": "3" }),
        )
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      await resultPromise;

      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 3_000,
      );
      expect(retryDelayCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a blank Retry-After header and still honors the body's RetryInfo", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(geminiRateLimitBody("26.6s"), false, 429, { "retry-after": "  " }),
        )
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const resultPromise = adapter.complete(baseRequest());
      await vi.runAllTimersAsync();
      await resultPromise;

      // `Number("  ")` is 0, so a blank header would otherwise read as a
      // present-but-zero hint and suppress the body fallback entirely.
      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 26_600,
      );
      expect(retryDelayCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to computed backoff when the body has no RetryInfo detail either", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, false, 429))
        .mockResolvedValueOnce(jsonResponse(validCompletionBody()));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

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

describe("createOpenAiCompatibleAdapter — 5xx exhausts retries", () => {
  it("throws LlmHttpError after bounded retries", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, false, 503));
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

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
      const adapter = createOpenAiCompatibleAdapter(PROFILE, {
        ...PERMISSIVE_OPTS,
        fetchImpl,
        timeoutMs: 1_000,
      });

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
      const adapter = createOpenAiCompatibleAdapter(PROFILE, {
        ...PERMISSIVE_OPTS,
        fetchImpl,
        timeoutMs: 1_000,
      });

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
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });

  it("throws LlmMalformedResponseError, not a zero-usage success, when usage is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      }),
    );
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

    await expect(adapter.complete(baseRequest())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });
});

describe("createOpenAiCompatibleAdapter — API key redaction", () => {
  it("never surfaces the raw API key in a thrown error on an HTTP error response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: `bad key ${PROFILE.apiKey}` }, false, 401));
    const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

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
      const adapter = createOpenAiCompatibleAdapter(PROFILE, { ...PERMISSIVE_OPTS, fetchImpl });

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
