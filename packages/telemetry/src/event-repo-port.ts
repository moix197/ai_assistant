import type { TelemetryEvent } from "@hermes/core";

/**
 * Persistence port for a flushed batch of telemetry events — a small
 * interface rather than a direct `@hermes/store` dependency, so
 * `@hermes/telemetry` stays decoupled from Postgres and the recorder stays
 * testable with a mock. Mirrors `packages/llm`'s `LlmUsageRepo`/
 * `BudgetUsageRepo` pattern. `apps/hermes/src/telemetry/build-telemetry-recorder.ts`
 * (Phase 2) wires this to `@hermes/store`'s `insertEvents(pool, events)`.
 */
export interface TelemetryEventRepo {
  insertEvents(events: TelemetryEvent[]): Promise<void>;
}
