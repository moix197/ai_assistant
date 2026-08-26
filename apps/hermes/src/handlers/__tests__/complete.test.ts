import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import { BudgetExceededError, LlmHttpError, type LlmProvider, LlmTimeoutError } from "@hermes/llm";
import { describe, expect, it, vi } from "vitest";
import { createCompletionHandler } from "../complete";

const ALLOWED_ID = 111;

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelUserId: String(ALLOWED_ID),
    chatId: "555",
    text: "hello",
    chatType: "private",
    kind: "message",
    ...overrides,
  };
}

describe("createCompletionHandler", () => {
  it("replies with result.text on the happy path", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const llmProvider: LlmProvider = {
      complete: vi.fn().mockResolvedValue({
        text: "a real llm reply",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
        finishReason: "stop",
      }),
    };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledWith("555", "a real llm reply");
  });

  it("passes the message text as the single user message, with model and maxTokens set", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const complete = vi.fn().mockResolvedValue({
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0 },
      finishReason: "stop",
    });
    const llmProvider: LlmProvider = { complete };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await handler(inboundMessage({ text: "what is the capital of France?" }));

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "some-model",
        messages: [{ role: "user", content: "what is the capital of France?" }],
        tools: undefined,
      }),
    );
  });

  it("replies with a generic message, not a thrown error, when the provider throws LlmHttpError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const llmProvider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new LlmHttpError("HTTP 500", 500)),
    };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [, replyText] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(replyText).not.toContain("HTTP 500");
  });

  it("replies with a generic message, not a thrown error, when the provider throws LlmTimeoutError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const llmProvider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new LlmTimeoutError("timed out")),
    };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("replies with the specific out-of-budget message, not the generic fallback, when the provider throws BudgetExceededError", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const llmProvider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new BudgetExceededError(5, 5.5)),
    };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await expect(handler(inboundMessage())).resolves.toBeUndefined();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [, replyText] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(replyText).toMatch(/budget/i);
    expect(replyText).not.toMatch(/\$5/);
    expect(replyText).not.toBe(
      "Sorry, I couldn't process that message right now. Please try again in a moment.",
    );
  });

  it("ignores an edited message, no provider call", async () => {
    const channel = createMockChannel();
    const logger = createMockLogger();
    const llmProvider: LlmProvider = { complete: vi.fn() };
    const handler = createCompletionHandler({ channel, llmProvider, model: "some-model", logger });

    await handler(inboundMessage({ kind: "edited_message" }));

    expect(llmProvider.complete).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });
});
