export type { TelemetryEvent, TelemetryRecorder } from "@hermes/core";
export type { TelemetryEventRepo } from "./event-repo-port";
export {
  type CreateBufferedTelemetryRecorderOptions,
  createBufferedTelemetryRecorder,
  type TelemetryRecorderHandle,
} from "./recorder";
