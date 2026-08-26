import { nextDelay } from "@hermes/core";
import { LlmHttpError, LlmMalformedResponseError, LlmTimeoutError } from "../errors";
import type {
  CompletionRequest,
  CompletionResult,
  FinishReason,
  LlmProvider,
  ProviderProfile,
} from "../port";

const REDACTED_KEY = "<REDACTED>";
const DEFAULT_TIMEOUT_MS = 30_000;

/** HTTP 429 (rate limited): server-supplied `retry_after` wins when present, still bounded. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** 5xx and network/timeout errors: bounded exponential backoff, then rethrow. */
const MAX_TRANSIENT_RETRIES = 5;

export interface OpenAiCompatibleAdapterOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout, ms. Default 30s. */
  timeoutMs?: number;
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function redact(value: string, apiKey: string): string {
  return value.split(apiKey).join(REDACTED_KEY);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assembles the outgoing body with `tools` -> `system` -> `messages` in
 * that literal key order (invariant #6: stable/shared prefix before
 * variable per-request content, for provider prompt-caching).
 */
function buildRequestBody(request: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model };
  if (request.tools !== undefined) {
    body.tools = request.tools;
  }
  body.system = request.system;
  body.messages = request.messages;
  body.max_tokens = request.maxTokens;
  return body;
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const KNOWN_FINISH_REASONS: readonly FinishReason[] = [
  "stop",
  "tool_calls",
  "length",
  "content_filter",
];

function normalizeFinishReason(raw: string | undefined): FinishReason {
  if (raw !== undefined && (KNOWN_FINISH_REASONS as readonly string[]).includes(raw)) {
    return raw as FinishReason;
  }
  return "stop";
}

/**
 * Parses an HTTP-200 body into a `CompletionResult`. Missing `text` or a
 * missing/partial `usage` block both throw `LlmMalformedResponseError`
 * rather than defaulting — a defaulted zero `usage` would silently record
 * zero cost for a real, billed call.
 */
function parseCompletionResponse(raw: unknown): CompletionResult {
  const payload = raw as OpenAiChatCompletionResponse;
  const choice = payload.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") {
    throw new LlmMalformedResponseError("LLM response is missing choices[0].message.content");
  }

  const usage = payload.usage;
  if (
    !usage ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number" ||
    typeof usage.total_tokens !== "number"
  ) {
    throw new LlmMalformedResponseError("LLM response is missing a well-formed usage block");
  }

  const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: parseToolCallArguments(call.function.arguments),
  }));

  return {
    text,
    toolCalls,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    finishReason: normalizeFinishReason(choice?.finish_reason),
  };
}

/**
 * Single attempt at one completion call. Throws `LlmTimeoutError` when this
 * function's own `AbortController` fires, `LlmHttpError` (carrying
 * `status`) for a non-ok HTTP response, or `LlmMalformedResponseError` for
 * a non-JSON or structurally incomplete HTTP-200 body. Every thrown message
 * is redacted before it leaves this function on every path.
 */
async function callOnce(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<CompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await requestOnce(fetchImpl, url, apiKey, body, controller.signal, timeoutMs);
    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      throw new LlmHttpError(
        redact(`LLM provider returned HTTP ${response.status}: ${rawText}`, apiKey),
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmMalformedResponseError("LLM response body is not valid JSON");
    }

    return parseCompletionResponse(payload);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmTimeoutError(`LLM request timed out after ${timeoutMs}ms`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`LLM request failed: ${message}`, apiKey));
  }
}

/**
 * Retries `callOnce` per the bounded policy mirroring
 * `channels/src/telegram/client.ts`'s `callWithRetry`: 429 waits for the
 * shared `nextDelay` (falling back to computed backoff), 5xx and
 * network/timeout errors back off exponentially and bounded, any other
 * non-ok status or a malformed body is not retried. Retries resend the
 * identical request body.
 */
async function completeWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<CompletionResult> {
  let rateLimitAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    try {
      return await callOnce(fetchImpl, url, apiKey, body, timeoutMs);
    } catch (error) {
      if (error instanceof LlmMalformedResponseError) throw error;

      if (error instanceof LlmHttpError) {
        if (error.status === 429) {
          rateLimitAttempt++;
          if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) throw error;
          await delay(nextDelay(rateLimitAttempt));
          continue;
        }
        if (error.status >= 500) {
          transientAttempt++;
          if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
          await delay(nextDelay(transientAttempt));
          continue;
        }
        throw error;
      }

      // LlmTimeoutError or a redacted network-failure Error: both transient.
      transientAttempt++;
      if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
      await delay(nextDelay(transientAttempt));
    }
  }
}

/** OpenAI-compatible adapter over raw `fetch`. No SDK: two endpoints don't justify a mega-package. */
export function createOpenAiCompatibleAdapter(
  profile: ProviderProfile,
  opts?: OpenAiCompatibleAdapterOptions,
): LlmProvider {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${profile.baseUrl}/chat/completions`;

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const body = buildRequestBody(request);
      return completeWithRetry(fetchImpl, url, profile.apiKey, body, timeoutMs);
    },
  };
}
