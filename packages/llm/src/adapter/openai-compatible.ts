import {
  type Clock,
  type Logger,
  type TelemetryEvent,
  type TelemetryRecorder,
  delay,
  nextDelay,
  systemClock,
} from "@hermes/core";
import { type BudgetUsageRepo, assertBudgetNotExceeded } from "../budget/check-budget";
import {
  LlmAbortedError,
  LlmHttpError,
  LlmMalformedResponseError,
  LlmTimeoutError,
} from "../errors";
import type {
  CompletionRequest,
  CompletionResult,
  FinishReason,
  LlmProvider,
  ProviderProfile,
  ToolDefinition,
} from "../port";
import { deriveBilledTokens, resolveCostUsd } from "../pricing";
import type { LlmUsageEntry, LlmUsageRepo } from "../usage/usage-repo-port";

const REDACTED_KEY = "<REDACTED>";
const DEFAULT_TIMEOUT_MS = 30_000;

/** HTTP 429 (rate limited): server-supplied `retry_after` wins when present, still bounded. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** 5xx and network/timeout errors: bounded exponential backoff, then rethrow. */
const MAX_TRANSIENT_RETRIES = 5;

/** Used when the caller supplies no `logger` — the usage-recording-failure and telemetry-drop warnings have somewhere safe to go. */
const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface OpenAiCompatibleAdapterOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout, ms. Default 30s. */
  timeoutMs?: number;
  /**
   * Records usage/cost after every successful `complete()`. Mandatory, not
   * optional-with-a-no-op-default: an adapter constructed without one used
   * to silently disable cost recording, which is exactly the failure mode
   * that let Phase 4's budget ceiling go unenforced for the real bot (see
   * `build-llm-provider.ts`). Every caller — production and test — must now
   * wire one explicitly, even a fake, so a missing wire is a compile error
   * instead of a silent no-op.
   */
  usageRepo: LlmUsageRepo;
  /** Receives usage-recording-failure and telemetry-drop warnings. Default: a no-op logger. */
  logger?: Logger;
  /**
   * Monthly budget ceiling (Phase 4). `usageRepo` and `capUsd` travel
   * together in one object so a partial config (one without the other) is
   * unrepresentable. Mandatory for the same reason `usageRepo` above is:
   * an optional-with-a-silent-skip default would let any construction site
   * — production or test — bypass the ceiling without anyone noticing.
   * `apps/hermes/src/llm/build-llm-provider.ts` is the one production
   * construction site and always supplies this; every test that doesn't
   * care about budget behavior passes an explicit, permissive cap instead
   * of relying on a default (see `check-budget.ts` for the check itself).
   */
  budget: { usageRepo: BudgetUsageRepo; capUsd: number; clock?: Clock };
  /**
   * Externally-supplied shutdown signal (Phase 5) — distinct from this
   * adapter's own per-request timeout controller. Optional: the poller is
   * serial (never more than one in-flight completion call), so a single
   * boot-lifetime controller from `apps/hermes/src/boot.ts` is sufficient
   * and composed with, not a replacement for, the timeout mechanism below.
   */
  signal?: AbortSignal;
  /**
   * Emits an `llm.call` telemetry event per completed (or failed) call.
   * Optional — `@hermes/llm` stays usable with no telemetry wired at all
   * (see `@hermes/telemetry`'s README for the recorder contract this relies
   * on: `record()` is synchronous, non-blocking, and never throws, so
   * calling it here can never slow or fail a real completion). Never fires
   * for a pre-flight `BudgetExceededError` rejection — no provider call was
   * attempted, so there is nothing to attribute a duration or cost to.
   */
  recorder?: TelemetryRecorder;
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** DeepSeek's own wire field for prefix-cache hits. */
    prompt_cache_hit_tokens?: number;
    /** The OpenAI-compatible shape Gemini's endpoint uses instead. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function redact(value: string, apiKey: string): string {
  return value.split(apiKey).join(REDACTED_KEY);
}

/**
 * Parses a `Retry-After` header value (seconds) into a number, or `undefined`
 * when absent, blank, non-numeric, or non-positive. Blank matters: `Number("")`
 * is `0`, which is non-nullish and would suppress the `RetryInfo` body fallback
 * below while also asking for five zero-wait retries.
 */
function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null || headerValue.trim() === "") return undefined;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Parses a protobuf `Duration` string (e.g. `"26.6s"`) into seconds, or `undefined` when malformed. */
function parseDurationSeconds(duration: unknown): number | undefined {
  if (typeof duration !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  return match ? Number(match[1]) : undefined;
}

/**
 * Falls back to the error body's `RetryInfo` detail when the response carried
 * no `Retry-After` header — Google's Generative Language API never sends that
 * header on a 429, but its JSON body includes a `google.rpc.RetryInfo` detail
 * with a `retryDelay` duration (e.g. `"26.6s"`) instead. Header wins when
 * present; this only runs as a fallback (see `callOnce`'s call site).
 */
function parseRetryInfoDelaySeconds(bodyText: string): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const details = (payload as { error?: { details?: unknown } })?.error?.details;
  if (!Array.isArray(details)) return undefined;

  const retryInfo = details.find(
    (detail): detail is { retryDelay?: unknown } =>
      typeof detail === "object" &&
      detail !== null &&
      "@type" in detail &&
      typeof (detail as { "@type"?: unknown })["@type"] === "string" &&
      (detail as { "@type": string })["@type"].endsWith("RetryInfo"),
  );
  return parseDurationSeconds(retryInfo?.retryDelay);
}

/**
 * Serializes one port-level `ToolDefinition` into the OpenAI-compatible wire
 * envelope. The port's shape is deliberately provider-neutral
 * (`{name, description, parameters}`); wrapping it in
 * `{type: "function", function: {...}}` is this adapter's job and nobody
 * else's. Posting the bare shape is rejected outright — DeepSeek answers
 * HTTP 400 "tools[0]: missing field `type`", Gemini's OpenAI-compatible
 * endpoint "Unknown name \"name\" at 'tools[0]'".
 */
function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Assembles the outgoing body with `tools` -> `messages` in that literal key
 * order (invariant #6: stable/shared prefix before variable per-request
 * content, for provider prompt-caching). OpenAI-compatible chat-completions
 * APIs (DeepSeek included) have no top-level `system` field — the system
 * prompt must be `messages[0]` with `role: "system"` or providers silently
 * ignore it. Placing it first within `messages` preserves the same
 * stable-prefix intent: `tools` (schema, most stable) -> system message
 * (stable per profile) -> variable per-turn messages.
 */
function buildRequestBody(request: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model };
  if (request.tools !== undefined) {
    body.tools = request.tools.map(toWireTool);
  }
  body.messages = [{ role: "system", content: request.system }, ...request.messages];
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
 * Reads cache-hit tokens from either wire shape a provider might use:
 * DeepSeek's own `prompt_cache_hit_tokens`, or the OpenAI-compatible
 * `prompt_tokens_details.cached_tokens` Gemini's endpoint uses. Absent or
 * non-numeric in both is a legitimate "no cache info" and returns `0` — only
 * a missing `usage` block entirely is treated as malformed.
 */
function parseCacheHitTokens(usage: OpenAiChatCompletionResponse["usage"]): number {
  if (typeof usage?.prompt_cache_hit_tokens === "number") return usage.prompt_cache_hit_tokens;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  return typeof cachedTokens === "number" ? cachedTokens : 0;
}

/**
 * Parses an HTTP-200 body into a `CompletionResult`. A body carrying neither
 * text nor a tool call, or a missing/partial `usage` block, throws
 * `LlmMalformedResponseError` rather than defaulting — a defaulted zero
 * `usage` would silently record zero cost for a real, billed call.
 */
function parseCompletionResponse(raw: unknown): CompletionResult {
  const payload = raw as OpenAiChatCompletionResponse;
  const choice = payload.choices?.[0];

  const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: parseToolCallArguments(call.function.arguments),
  }));

  // OpenAI-compatible providers answer a tool call with `content: null` — the
  // tool call *is* the message. Only a reply carrying neither is malformed.
  const content = choice?.message?.content;
  if (typeof content !== "string" && toolCalls.length === 0) {
    throw new LlmMalformedResponseError(
      "LLM response has neither choices[0].message.content nor choices[0].message.tool_calls",
    );
  }
  const text = typeof content === "string" ? content : "";

  const usage = payload.usage;
  if (
    !usage ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number" ||
    typeof usage.total_tokens !== "number"
  ) {
    throw new LlmMalformedResponseError("LLM response is missing a well-formed usage block");
  }

  return {
    text,
    toolCalls,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheHitTokens: parseCacheHitTokens(usage),
    },
    finishReason: normalizeFinishReason(choice?.finish_reason),
  };
}

/**
 * Classifies an abort into the right typed error. The externally-supplied
 * shutdown `signal` firing is checked first — it's the more specific,
 * deliberate cause ("shutdown asked us to stop") — falling back to the
 * adapter's own per-request timeout otherwise. Composition (not
 * replacement, see `composeSignal`) is what makes both causes distinguishable
 * from the same combined `AbortSignal` at this single point.
 */
function classifyAbort(externalSignal: AbortSignal | undefined, timeoutMs: number): Error {
  if (externalSignal?.aborted) {
    return new LlmAbortedError("LLM request aborted by external shutdown signal");
  }
  return new LlmTimeoutError(`LLM request timed out after ${timeoutMs}ms`);
}

/**
 * Combines this call's own per-request timeout signal with the adapter's
 * optional externally-supplied shutdown `signal`, so either can abort the
 * underlying `fetch` — composition, not replacement, of the timeout
 * mechanism.
 */
function composeSignal(
  timeoutSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
): AbortSignal {
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

/**
 * Single attempt at one completion call. Throws `LlmAbortedError` when the
 * externally-supplied shutdown `signal` fires, `LlmTimeoutError` when this
 * function's own per-request timeout fires instead, `LlmHttpError` (carrying
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
  externalSignal: AbortSignal | undefined,
): Promise<CompletionResult> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = composeSignal(timeoutController.signal, externalSignal);

  try {
    const response = await requestOnce(
      fetchImpl,
      url,
      apiKey,
      body,
      signal,
      timeoutMs,
      externalSignal,
    );
    if (!response.ok) {
      const rawText = await response.text().catch(() => {
        if (signal.aborted) throw classifyAbort(externalSignal, timeoutMs);
        return "";
      });
      const retryAfter =
        parseRetryAfterSeconds(response.headers.get("retry-after")) ??
        parseRetryInfoDelaySeconds(rawText);
      throw new LlmHttpError(
        redact(`LLM provider returned HTTP ${response.status}: ${rawText}`, apiKey),
        response.status,
        retryAfter,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (signal.aborted) throw classifyAbort(externalSignal, timeoutMs);
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
  externalSignal: AbortSignal | undefined,
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
      throw classifyAbort(externalSignal, timeoutMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`LLM request failed: ${message}`, apiKey));
  }
}

/**
 * Sleeps for the retry backoff, then re-checks `externalSignal` — an abort
 * that lands mid-sleep must surface as `LlmAbortedError` immediately rather
 * than let the loop spend another attempt (which would itself just abort).
 * Reuses `classifyAbort`, the same classification `callOnce`'s `fetch` path
 * uses, so a shutdown mid-backoff and a shutdown mid-request are
 * indistinguishable to the caller.
 */
async function sleepUnlessAborted(
  ms: number,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  await delay(ms, externalSignal);
  if (externalSignal?.aborted) throw classifyAbort(externalSignal, timeoutMs);
}

/**
 * Retries `callOnce` per the bounded policy mirroring
 * `channels/src/telegram/client.ts`'s `callWithRetry`: 429 waits for the
 * shared `nextDelay` (falling back to computed backoff), 5xx and
 * network/timeout errors back off exponentially and bounded, any other
 * non-ok status or a malformed body is not retried. Retries resend the
 * identical request body. A shutdown-triggered `LlmAbortedError` is never
 * retried either — retrying would defeat the point of a prompt shutdown.
 * `externalSignal?.aborted` is checked first, ahead of the error's own type:
 * shutdown is the more specific, deliberate cause (mirroring `classifyAbort`'s
 * own precedence) and pre-empts any retry classification a same-tick network
 * failure would otherwise get, so a shutdown never burns another attempt.
 */
async function completeWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<CompletionResult> {
  let rateLimitAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    try {
      return await callOnce(fetchImpl, url, apiKey, body, timeoutMs, externalSignal);
    } catch (error) {
      if (externalSignal?.aborted) throw classifyAbort(externalSignal, timeoutMs);
      if (error instanceof LlmAbortedError) throw error;
      if (error instanceof LlmMalformedResponseError) throw error;

      if (error instanceof LlmHttpError) {
        if (error.status === 429) {
          rateLimitAttempt++;
          if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) throw error;
          await sleepUnlessAborted(
            nextDelay(rateLimitAttempt, error.retryAfter),
            externalSignal,
            timeoutMs,
          );
          continue;
        }
        if (error.status >= 500) {
          transientAttempt++;
          if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
          await sleepUnlessAborted(nextDelay(transientAttempt), externalSignal, timeoutMs);
          continue;
        }
        throw error;
      }

      // LlmTimeoutError or a redacted network-failure Error: both transient.
      transientAttempt++;
      if (transientAttempt > MAX_TRANSIENT_RETRIES) throw error;
      await sleepUnlessAborted(nextDelay(transientAttempt), externalSignal, timeoutMs);
    }
  }
}

/**
 * The `provider` label recorded on each usage row: the API host, derived
 * from the profile's own `baseUrl` rather than a hardcoded family name, so
 * a future model/host needs no change here to be labeled correctly.
 */
function deriveProviderLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Records one successful call's usage and cost, and returns the `entry` it
 * built — reused by `complete()`'s telemetry emission below instead of
 * re-deriving cost/tokens a second time (two independent derivations of the
 * same cost number is exactly the drift risk `llm-cost-accounting.md` exists
 * to prevent). Called from the adapter's success path only — a failed call
 * has no billed tokens to record. Never called from
 * `parseCompletionResponse`/`callOnce`/`completeWithRetry` directly: those
 * run once per HTTP attempt, including retries, and usage must be recorded
 * exactly once per logical `complete()` call.
 *
 * Can reject with `UnpricedModelError` (via `resolveCostUsd`) for a model
 * absent from `MODEL_PRICING` — deliberately uncaught here, so it propagates
 * out of `complete()` and discards an already-paid-for reply rather than
 * silently recording `$0` for it. Boot-time `assertModelsPriced` is meant to
 * keep this path rare; see `.ai/decisions/llm-cost-accounting.md`.
 */
async function recordCompletionUsage(
  usageRepo: LlmUsageRepo,
  logger: Logger,
  profile: ProviderProfile,
  request: CompletionRequest,
  result: CompletionResult,
): Promise<LlmUsageEntry> {
  const costUsd = resolveCostUsd(request.model, result.usage);
  const { missTokens, reasoningTokens } = deriveBilledTokens(result.usage);
  const entry: LlmUsageEntry = {
    provider: deriveProviderLabel(profile.baseUrl),
    model: request.model,
    inputTokens: missTokens,
    outputTokens: result.usage.completionTokens + reasoningTokens,
    cacheHitTokens: result.usage.cacheHitTokens,
    costUsd,
  };

  // The provider call already succeeded and the tokens are already billed by
  // this point — a bookkeeping failure here must not throw away an
  // already-paid-for reply. Log and continue instead of letting complete()
  // reject; the fields below let the row be reconstructed from logs.
  try {
    await usageRepo.recordUsage(entry);
  } catch (error) {
    logger.error(
      "failed to record llm usage — call succeeded and was billed, but the row was not persisted",
      {
        provider: entry.provider,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheHitTokens: entry.cacheHitTokens,
        costUsd: entry.costUsd,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return entry;
}

/**
 * Token counts for the on-error `llm.call` event. Zeroed when no response was
 * ever produced (`completeWithRetry` itself failed) — there's nothing billed
 * to report. Derived from the completion's own usage block when the failure
 * happened later, while recording it (`recordCompletionUsage`, e.g. an
 * `UnpricedModelError`): those tokens were genuinely billed even though the
 * cost could not be resolved, so they're worth surfacing even as `costUsd: 0`.
 */
function errorEventTokens(result: CompletionResult | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
} {
  if (!result) return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
  const { missTokens, reasoningTokens } = deriveBilledTokens(result.usage);
  return {
    inputTokens: missTokens,
    outputTokens: result.usage.completionTokens + reasoningTokens,
    cacheHitTokens: result.usage.cacheHitTokens,
  };
}

/**
 * Calls `recorder.record()` and swallows anything it throws — `recorder` is
 * a public adapter option, so a third-party implementation throwing must
 * never replace the provider error at the failure call site or fail an
 * already-paid-for successful completion at the success call site.
 */
function safeRecord(
  recorder: TelemetryRecorder | undefined,
  logger: Logger,
  event: TelemetryEvent,
): void {
  try {
    recorder?.record(event);
  } catch (error) {
    logger.warn("telemetry recorder threw — event dropped", {
      name: event.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** OpenAI-compatible adapter over raw `fetch`. No SDK: two endpoints don't justify a mega-package. */
export function createOpenAiCompatibleAdapter(
  profile: ProviderProfile,
  opts: OpenAiCompatibleAdapterOptions,
): LlmProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const usageRepo = opts.usageRepo;
  const logger = opts.logger ?? NOOP_LOGGER;
  const url = `${profile.baseUrl}/chat/completions`;

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      // Checked before building the request or issuing any fetch — a breach
      // must cost nothing, not merely record nothing. `opts.budget` is
      // mandatory (see OpenAiCompatibleAdapterOptions), so this always runs.
      const { usageRepo: budgetUsageRepo, capUsd, clock } = opts.budget;
      await assertBudgetNotExceeded(budgetUsageRepo, capUsd, clock ?? systemClock);

      const body = buildRequestBody(request);
      // Timed from immediately after the budget check — nothing attempted
      // yet. On the success path the clock stops the moment
      // `completeWithRetry` settles, so `recordCompletionUsage`'s DB write is
      // excluded from the latency metric. The catch below reads the clock
      // later, so a failure raised *inside* `recordCompletionUsage` (an
      // `UnpricedModelError`) does include that write — deliberate: an
      // error's duration is a diagnostic, not the latency number `/stats`
      // reports. See `packages/llm/README.md`.
      const startedAt = Date.now();
      let result: CompletionResult | undefined;
      try {
        result = await completeWithRetry(
          fetchImpl,
          url,
          profile.apiKey,
          body,
          timeoutMs,
          opts.signal,
        );
        const durationMs = Date.now() - startedAt;
        const entry = await recordCompletionUsage(usageRepo, logger, profile, request, result);
        safeRecord(opts.recorder, logger, {
          name: "llm.call",
          threadId: null,
          turnId: null,
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheHitTokens: entry.cacheHitTokens,
          durationMs,
          costUsd: entry.costUsd,
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        safeRecord(opts.recorder, logger, {
          name: "llm.call",
          threadId: null,
          turnId: null,
          model: request.model,
          ...errorEventTokens(result),
          durationMs,
          costUsd: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
