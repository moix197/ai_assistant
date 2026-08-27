import type { Logger } from "@hermes/core";
import { type Pool, insertEvents } from "@hermes/store";
import { type TelemetryRecorderHandle, createBufferedTelemetryRecorder } from "@hermes/telemetry";

/**
 * Wires the buffered recorder to real infrastructure: `@hermes/store`'s
 * `insertEvents` against the live pool, and the app's real logger so
 * overflow/flush-failure warnings land somewhere visible instead of the
 * recorder's no-op default. Extracted from `boot()` so this wiring is
 * testable without booting the whole process, matching
 * `build-llm-provider.ts`'s shape.
 */
export function buildTelemetryRecorder(pool: Pool, logger: Logger): TelemetryRecorderHandle {
  return createBufferedTelemetryRecorder(
    { insertEvents: (events) => insertEvents(pool, events) },
    { logger },
  );
}
