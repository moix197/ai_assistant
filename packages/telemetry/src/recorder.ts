import type { Logger, TelemetryEvent, TelemetryRecorder } from "@hermes/core";
import type { TelemetryEventRepo } from "./event-repo-port";

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_FLUSH_THRESHOLD = 50;
/** A **count** of buffered events, not a byte size. See package README. */
const DEFAULT_MAX_BUFFER_SIZE = 500;

/** Used when the caller supplies no `logger` — overflow/drop warnings have somewhere safe to go. */
const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface CreateBufferedTelemetryRecorderOptions {
  /** How often the buffer flushes on a timer, independent of `flushThreshold`. Default 5000ms. */
  flushIntervalMs?: number;
  /** Buffer size at which a flush is triggered immediately (fire-and-forget). Default 50. */
  flushThreshold?: number;
  /** Hard cap on buffered events (a count, not bytes). Default 500. */
  maxBufferSize?: number;
  /** Receives overflow/drop/flush-failure warnings and errors. Default: a no-op logger. */
  logger?: Logger;
}

export interface TelemetryRecorderHandle extends TelemetryRecorder {
  /**
   * Stops the periodic flush timer, then awaits one final flush of whatever
   * remains buffered. Idempotent-by-contract for `record()` afterward: any
   * event recorded once this resolves is dropped, never buffered or
   * flushed — this has no internal timeout, it is the caller's job to
   * bound how long it waits (see `apps/hermes/src/boot.ts`'s shutdown
   * sequence, Phase 2).
   */
  stop(): Promise<void>;
}

/**
 * Buffered, at-most-once `TelemetryRecorder`. `record()` is synchronous,
 * never awaits anything, and never throws — including after `stop()` has
 * resolved — by design: this sits on the paid LLM completion path and must
 * never become a way to fail or slow a user's request. See
 * `packages/telemetry/README.md` for the full failure-mode contract
 * (overflow, flush failure, post-`stop()` calls).
 */
export function createBufferedTelemetryRecorder(
  repo: TelemetryEventRepo,
  opts: CreateBufferedTelemetryRecorderOptions = {},
): TelemetryRecorderHandle {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushThreshold = opts.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  const maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const logger = opts.logger ?? NOOP_LOGGER;

  let buffer: TelemetryEvent[] = [];
  let stopped = false;
  let flushing: Promise<void> | null = null;

  function drainBuffer(): TelemetryEvent[] {
    const batch = buffer;
    buffer = [];
    return batch;
  }

  /**
   * Drains the buffer and sends it, unconditionally — callers are
   * responsible for single-flighting. A rejected `repo.insertEvents` is
   * logged at `error` and the batch is discarded — no requeue, no retry —
   * leaving the recorder able to flush normally on the next trigger.
   */
  async function performFlush(): Promise<void> {
    const batch = drainBuffer();
    try {
      await repo.insertEvents(batch);
    } catch (error) {
      logger.error("telemetry flush failed, batch discarded", {
        count: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Single-flights `performFlush`: if a flush is already in progress, this
   * is a no-op — the buffer keeps accumulating (up to `maxBufferSize`)
   * instead of spawning a second concurrent `insertEvents` call. This is
   * what makes `maxBufferSize` the real backpressure valve when
   * `flushThreshold` is reached repeatedly while Postgres is slow.
   */
  function triggerFlush(): void {
    if (flushing) return;
    flushing = performFlush().finally(() => {
      flushing = null;
    });
  }

  function logDroppedEvent(event: TelemetryEvent, reason: string): void {
    logger.warn("telemetry event dropped", { name: event.name, reason });
  }

  const interval = setInterval(() => {
    triggerFlush();
  }, flushIntervalMs);
  interval.unref?.();

  return {
    record(event: TelemetryEvent): void {
      if (stopped) {
        logDroppedEvent(event, "recorder stopped");
        return;
      }
      if (buffer.length >= maxBufferSize) {
        logDroppedEvent(event, "buffer full");
        return;
      }
      buffer.push(event);
      if (buffer.length >= flushThreshold) {
        triggerFlush();
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (flushing) await flushing;
      await performFlush();
    },
  };
}
