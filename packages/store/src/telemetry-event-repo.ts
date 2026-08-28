import type { TelemetryEvent } from "@hermes/core";
import type { Pool } from "pg";

interface TelemetryEventRow {
  name: string;
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
  durationMs: number | null;
  costUsd: number | null;
  /** A `turn` row's total cost across its `llm.call`s. Null on every other event kind. See `cost_usd` above. */
  totalCostUsd: number | null;
  isError: boolean;
  fields: Record<string, unknown>;
}

/**
 * Splits one `TelemetryEvent` into the fixed columns every event's rollup
 * queries filter/aggregate on, plus a `fields` jsonb bag for the rest.
 * `isError` is derived per event kind: `llm.call` and `tool.call` carry an
 * optional `error`, so `isError` is that field's presence; `turn` carries no
 * `error` field, so `isError` is derived from its `outcome` instead —
 * `"error"` or `"aborted"` are errors, `"completed"`/`"max_iterations"` are
 * not. `is_error` is a rollup filter column (see `packages/store/README.md`),
 * so a `turn` row must set it consistently with the other two kinds.
 */
function toRow(event: TelemetryEvent): TelemetryEventRow {
  const base = { threadId: event.threadId, turnId: event.turnId, durationMs: event.durationMs };

  switch (event.name) {
    case "llm.call":
      return {
        ...base,
        name: event.name,
        toolName: null,
        costUsd: event.costUsd,
        totalCostUsd: null,
        isError: event.error !== undefined,
        fields: {
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheHitTokens: event.cacheHitTokens,
          ...(event.error !== undefined ? { error: event.error } : {}),
        },
      };
    case "tool.call":
      return {
        ...base,
        name: event.name,
        toolName: event.tool,
        costUsd: null,
        totalCostUsd: null,
        isError: event.error !== undefined,
        fields: {
          approved: event.approved,
          ...(event.error !== undefined ? { error: event.error } : {}),
        },
      };
    case "turn":
      // `cost_usd` stays NULL here — it means exactly one thing everywhere
      // else in this table: the cost of a single `llm.call`. A turn's total
      // goes in its own column instead (03-agent-core settled decision 1),
      // closing the double-count `02-telemetry` deferred.
      return {
        ...base,
        name: event.name,
        toolName: null,
        costUsd: null,
        totalCostUsd: event.totalCostUsd,
        isError: event.outcome === "error" || event.outcome === "aborted",
        fields: { iterations: event.iterations, outcome: event.outcome },
      };
  }
}

const COLUMNS_PER_ROW = 9;

function buildPlaceholderGroup(rowIndex: number): string {
  const start = rowIndex * COLUMNS_PER_ROW + 1;
  const placeholders = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${start + i}`);
  return `(${placeholders.join(", ")})`;
}

function flattenRowValues(row: TelemetryEventRow): unknown[] {
  return [
    row.name,
    row.threadId,
    row.turnId,
    row.toolName,
    row.durationMs,
    row.costUsd,
    row.totalCostUsd,
    row.isError,
    JSON.stringify(row.fields),
  ];
}

/**
 * Inserts every event in one multi-row `INSERT` — never a loop of
 * single-row inserts, since a burst-flushed buffer of up to `flushThreshold`
 * (or `maxBufferSize`) events must not become that many round trips. No-op
 * (issues no query at all) on an empty array: a periodic flush firing on an
 * empty buffer is the common case, not the exception.
 */
export async function insertEvents(pool: Pool, events: TelemetryEvent[]): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map(toRow);
  const valuesSql = rows.map((_, i) => buildPlaceholderGroup(i)).join(", ");
  const params = rows.flatMap(flattenRowValues);

  await pool.query(
    `INSERT INTO telemetry_events (name, thread_id, turn_id, tool_name, duration_ms, cost_usd, total_cost_usd, is_error, fields)
     VALUES ${valuesSql}`,
    params,
  );
}
