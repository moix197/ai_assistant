import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import {
  type Pool,
  claim as claimDedupe,
  complete as completeDedupe,
  createPool,
  getDefaultMigrationsDir,
  recordUsage,
  runMigrations,
} from "@hermes/store";
import { testDatabaseUrl } from "@hermes/store/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "../../agent/build-agent";
import { createCompletionHandler } from "../complete";

const ALLOWED_ID = 111;

function createMockLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function createRecordingChannel(): Channel & { sent: string[] } {
  const sent: string[] = [];
  return {
    capabilities: { markdown: true, files: false, buttons: false, maxMessageLength: 4096 },
    subscribe: () => {},
    sent,
    async send(_target, text) {
      sent.push(text);
    },
  };
}

function inboundMessage(updateId: number): InboundMessage {
  return {
    channelUserId: String(ALLOWED_ID),
    chatId: "555",
    text: "hello",
    chatType: "private",
    kind: "message",
    updateId,
  };
}

/**
 * Stands in for the agent loop without any live network call: counts
 * invocations and, on each one, records a real `llm_usage` row against the
 * scratch DB — mirroring what a real turn's success path does — so this
 * suite can assert "one agent call, one usage row" against real persisted
 * state, not just a call-count spy.
 */
function createRecordingFakeAgent(pool: Pool, calls: { count: number }): Agent {
  return {
    async handleMessage() {
      calls.count++;
      await recordUsage(pool, {
        provider: "fake-provider",
        model: "some-model",
        inputTokens: 10,
        outputTokens: 5,
        cacheHitTokens: 0,
        costUsd: 0.0001,
      });
      return `reply #${calls.count}`;
    },
  };
}

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
describe.skipIf(!testDatabaseUrl)(
  "createCompletionHandler — exact-duplicate dedupe (integration)",
  () => {
    let pool: Pool;

    beforeEach(async () => {
      pool = createPool(testDatabaseUrl as string);
      await runMigrations(pool, getDefaultMigrationsDir());
      await pool.query("DELETE FROM llm_dedupe");
      await pool.query("DELETE FROM llm_usage");
    });

    afterEach(async () => {
      await pool.end();
    });

    it("an identical Telegram update fed through the handler twice results in exactly one provider call and exactly one llm_usage row", async () => {
      const channel = createRecordingChannel();
      const logger = createMockLogger();
      const calls = { count: 0 };
      const agent = createRecordingFakeAgent(pool, calls);
      const dedupeRepo = {
        claim: (dedupeKey: string) => claimDedupe(pool, dedupeKey),
        complete: (dedupeKey: string, resultText: string) =>
          completeDedupe(pool, dedupeKey, resultText),
      };
      const handler = createCompletionHandler({
        channel,
        agent,
        logger,
        dedupeRepo,
      });

      const message = inboundMessage(9001);

      // Sequentially, after the first delivery has fully completed — the
      // exact-duplicate-delivery scenario invariant #4 exists to close.
      await handler(message);
      await handler(message);

      expect(calls.count).toBe(1);
      expect(channel.sent).toEqual(["reply #1", "reply #1"]);

      const usageRows = await pool.query("SELECT COUNT(*)::int AS count FROM llm_usage");
      expect(usageRows.rows[0].count).toBe(1);

      const dedupeRows = await pool.query(
        "SELECT status, result_text FROM llm_dedupe WHERE dedupe_key = $1",
        ["telegram:9001"],
      );
      expect(dedupeRows.rows[0]).toEqual({ status: "completed", result_text: "reply #1" });
    });
  },
);
