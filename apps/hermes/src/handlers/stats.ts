import type { Channel, InboundMessage } from "@hermes/channels";
import type { Clock } from "@hermes/core";
import { type StatsRepo, computeStats, formatStatsMessage } from "@hermes/telemetry";

/**
 * `/stats` — thin wiring only, per CLAUDE.md's thin-entry-points rule: the
 * actual math lives in `@hermes/telemetry`'s `computeStats`, the rendering
 * in its `formatStatsMessage`. This handler calls both and sends the result.
 */
export function createStatsHandler(
  channel: Channel,
  statsRepo: StatsRepo,
  clock: Clock,
  capUsd: number,
): (message: InboundMessage, args?: string) => Promise<void> {
  return async function handleStats(message: InboundMessage, _args?: string): Promise<void> {
    const stats = await computeStats(statsRepo, clock, capUsd);
    await channel.send(message.chatId, formatStatsMessage(stats));
  };
}
