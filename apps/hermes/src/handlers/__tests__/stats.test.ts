import type { Channel, InboundMessage } from "@hermes/channels";
import type { Clock } from "@hermes/core";
import type { StatsRepo } from "@hermes/telemetry";
import { describe, expect, it, vi } from "vitest";
import { createStatsHandler } from "../stats";

function createMockChannel(): Channel {
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeStatsRepo(): StatsRepo {
  return {
    sumCostSince: vi.fn().mockResolvedValue(1.5),
    getLlmCallStatsSince: vi.fn().mockResolvedValue({
      calls: 1,
      errorCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheHitTokens: 0,
    }),
    getTopToolsSince: vi.fn().mockResolvedValue([]),
  };
}

function inboundMessage(): InboundMessage {
  return {
    channelUserId: "111",
    chatId: "555",
    text: "/stats",
    chatType: "private",
    kind: "message",
    updateId: 1,
  };
}

describe("createStatsHandler", () => {
  it("computes stats and sends the formatted message via channel.send", async () => {
    const channel = createMockChannel();
    const statsRepo = createFakeStatsRepo();
    const clock: Clock = { now: () => new Date("2026-08-27T12:00:00.000Z") };
    const handler = createStatsHandler(channel, statsRepo, clock, 100);

    await handler(inboundMessage());

    expect(channel.send).toHaveBeenCalledTimes(1);
    const [chatId, text] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe("555");
    expect(text).toContain("Spend today:");
    expect(text).toContain("no tool calls recorded yet");
  });
});
