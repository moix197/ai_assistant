import type { TelemetryEvent } from "@hermes/core";
import type { Pool } from "pg";

interface TelemetryEventRow {
  name: string;
  threadId: string | null;
  turnId: string | null;
  toolName: string | null;
  durationMs: number | null;
  costUsd: number | null;
  isError: boolean;
  fields: Record<string, unknown>;
}

/**
 * Splits one `TelemetryEvent` into the fixed columns every event's rollup
 * queries filter/aggregate on, plus a `fields` jsonb bag for the rest.
 * `isError` is derived from the event's own `error` presence — `llm.call`
 * and `tool.call` carry an optional `error`, `turn` never does.
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
        isError: event.error !== undefined,
        fields: {
          approved: event.approved,
          ...(event.error !== undefined ? { error: event.error } : {}),
        },
      };
    case "turn":
      return {
        ...base,
        name: event.name,
        toolName: null,
        costUsd: event.totalCostUsd,
        isError: false,
        fields: { iterations: event.iterations, outcome: event.outcome },
      };
  }
}

const COLUMNS_PER_ROW = 8;

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
    `INSERT INTO telemetry_events (name, thread_id, turn_id, tool_name, duration_ms, cost_usd, is_error, fields)
     VALUES ${valuesSql}`,
    params,
  );
}
