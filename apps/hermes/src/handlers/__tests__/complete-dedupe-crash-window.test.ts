import type { Channel, InboundMessage } from "@hermes/channels";
import type { Logger } from "@hermes/core";
import {
  type Pool,
  claim as claimDedupe,
  complete as completeDedupe,
  createPool,
  getDefaultMigrationsDir,
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
      return { messageId: "test-message-id" };
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

/** Stands in for the agent loop without any live network call: counts invocations, no usage recording (irrelevant to this suite). */
function createCountingFakeAgent(calls: { count: number }): Agent {
  return {
    async handleMessage() {
      calls.count++;
      return `reply #${calls.count}`;
    },
  };
}

// Integration coverage — skipped unless TEST_DATABASE_URL is set. See
// packages/store/README.md for how to run this locally.
describe.skipIf(!testDatabaseUrl)(
  "createCompletionHandler — claim-to-complete crash window (accepted risk, integration)",
  () => {
    let pool: Pool;

    beforeEach(async () => {
      pool = createPool(testDatabaseUrl as string);
      await runMigrations(pool, getDefaultMigrationsDir());
      await pool.query("DELETE FROM llm_dedupe");
    });

    afterEach(async () => {
      await pool.end();
    });

    it("a retry after a claimed-but-never-completed row is not permanently blocked, and a later redelivery still short-circuits once completed", async () => {
      const dedupeKey = "telegram:9002";

      // Simulates "claimed, provider call started" then a crash before
      // complete() ever runs — the row is left pending.
      const firstClaim = await claimDedupe(pool, dedupeKey);
      expect(firstClaim).toEqual({ status: "claimed" });

      const channel = createRecordingChannel();
      const logger = createMockLogger();
      const calls = { count: 0 };
      const agent = createCountingFakeAgent(calls);
      const dedupeRepo = {
        claim: (key: string) => claimDedupe(pool, key),
        complete: (key: string, resultText: string) => completeDedupe(pool, key, resultText),
      };
      const handler = createCompletionHandler({
        channel,
        agent,
        logger,
        dedupeRepo,
      });

      // A second claim of the same key after the simulated crash — the
      // DB-level fail-open branch must proceed, not permanently block. What
      // reaches it is a `callback_query` replay; a message update is acked
      // before its handler is dispatched, so its `pending` row is inert.
      await handler(inboundMessage(9002));

      expect(calls.count).toBe(1);
      expect(channel.sent).toEqual(["reply #1"]);

      const dedupeRow = await pool.query(
        "SELECT status, result_text FROM llm_dedupe WHERE dedupe_key = $1",
        [dedupeKey],
      );
      expect(dedupeRow.rows[0]).toEqual({ status: "completed", result_text: "reply #1" });

      // A third delivery of the same update_id, now that the row is
      // genuinely completed, must short-circuit via the stored result —
      // zero further provider calls.
      await handler(inboundMessage(9002));

      expect(calls.count).toBe(1);
      expect(channel.sent).toEqual(["reply #1", "reply #1"]);
    });
  },
);
