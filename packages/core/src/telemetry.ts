// Port only — no implementation ships in this phase. ROADMAP's boundary rule
// requires this port to exist in `core` before Phase 2 wires a real recorder
// through it, so callers depend on the port now rather than it being
// retrofitted through half the tree later. Zero runtime footprint: nothing
// calls this yet.

export interface TelemetryEvent {
  name: string;
  fields?: Record<string, unknown>;
}

export interface TelemetryRecorder {
  record(event: TelemetryEvent): void;
}
