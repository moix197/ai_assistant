import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpRetry } from "../http-retry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A trivial attempt() that always fails — the retry mechanics under test never inspect its resolved value. */
function alwaysFails(error: unknown): (signal: AbortSignal) => Promise<never> {
  return () => Promise.reject(error);
}

describe("withHttpRetry — named retry classes", () => {
  it("enforces each class's own bound in a 2-class configuration", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          return Promise.reject(new Error("boom"));
        },
        timeoutMs: 30_000,
        classes: {
          rateLimit: { maxAttempts: 5 },
          transient: { maxAttempts: 2 },
        },
        classify: (): { class: "rateLimit" | "transient" } => ({ class: "transient" }),
      }).catch((error: unknown) => error);

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      // 1 initial attempt + 2 bounded retries under "transient", then it gives up.
      expect(attempts).toBe(3);
      expect(error).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces each class's own bound independently in a 3-class configuration", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          // Every attempt classifies as "conflict" — only that class's bound applies.
          return Promise.reject(new Error("conflict"));
        },
        timeoutMs: 30_000,
        classes: {
          rateLimit: { maxAttempts: 5 },
          conflict: { maxAttempts: 3 },
          transient: { maxAttempts: 5 },
        },
        classify: (): { class: "rateLimit" | "conflict" | "transient" } => ({ class: "conflict" }),
      }).catch((error: unknown) => error);

      await vi.runAllTimersAsync();
      await resultPromise;

      // 1 initial attempt + 3 bounded retries under "conflict".
      expect(attempts).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each class's attempt counter independent when classifications interleave", async () => {
    vi.useFakeTimers();
    try {
      // Alternates rateLimit/conflict/rateLimit/conflict/rateLimit — if the
      // counters were shared instead of per-class, this would exhaust after
      // 2 total attempts (rateLimit's bound); independent counters mean it
      // takes 5, exhausting only once rateLimit's own count (3) exceeds its
      // own bound (2), with conflict's count (2) nowhere near its bound (5).
      const classSequence: Array<"rateLimit" | "conflict"> = [
        "rateLimit",
        "conflict",
        "rateLimit",
        "conflict",
        "rateLimit",
      ];
      let attempts = 0;

      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          return Promise.reject(new Error(`attempt ${attempts}`));
        },
        timeoutMs: 30_000,
        classes: {
          rateLimit: { maxAttempts: 2 },
          conflict: { maxAttempts: 5 },
          transient: { maxAttempts: 5 },
        },
        classify: (): { class: "rateLimit" | "conflict" | "transient" } => ({
          // `attempts` never exceeds `classSequence.length` here (the loop
          // throws before a 6th attempt); the fallback only satisfies
          // `noUncheckedIndexedAccess`, it's never actually reached.
          class: classSequence[attempts - 1] ?? "transient",
        }),
      }).catch((error: unknown) => error);

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(attempts).toBe(5);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("attempt 5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a class-specific exhausted-retries error instead of rethrowing the last attempt's error verbatim", async () => {
    vi.useFakeTimers();
    try {
      const perAttemptError = new Error("conflict, attempt failed");
      const exhaustedError = new Error("conflict persisted after retries");

      const resultPromise = withHttpRetry({
        attempt: alwaysFails(perAttemptError),
        timeoutMs: 30_000,
        classes: {
          conflict: {
            maxAttempts: 1,
            buildExhaustedError: () => exhaustedError,
          },
        },
        classify: () => ({ class: "conflict" as const }),
      }).catch((error: unknown) => error);

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBe(exhaustedError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withHttpRetry — retryAfterMs precedence", () => {
  it("waits the caller-supplied retryAfterMs instead of computed backoff", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      let attempts = 0;

      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          if (attempts === 1) return Promise.reject(new Error("rate limited"));
          return Promise.resolve("ok");
        },
        timeoutMs: 30_000,
        classes: { rateLimit: { maxAttempts: 5 } },
        classify: () => ({ class: "rateLimit" as const, retryAfterMs: 7_000 }),
      });

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe("ok");
      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 7_000,
      );
      expect(retryDelayCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a retryAfterMs that exceeds the backoff ceiling, same as computed backoff", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      let attempts = 0;

      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          if (attempts === 1) return Promise.reject(new Error("rate limited"));
          return Promise.resolve("ok");
        },
        timeoutMs: 30_000,
        classes: { rateLimit: { maxAttempts: 5 } },
        classify: () => ({ class: "rateLimit" as const, retryAfterMs: 120_000 }),
      });

      await vi.runAllTimersAsync();
      await resultPromise;

      const retryDelayCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] === 30_000,
      );
      expect(retryDelayCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withHttpRetry — external shutdown signal", () => {
  it("aborts an in-flight retry loop promptly instead of exhausting the retry policy, when buildAbortedError is supplied", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attempts = 0;

      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          return Promise.reject(new Error("transient failure"));
        },
        timeoutMs: 30_000,
        externalSignal: controller.signal,
        classes: { transient: { maxAttempts: 5 } },
        classify: () => ({ class: "transient" as const }),
        buildAbortedError: () => new Error("aborted"),
      }).catch((error: unknown) => error);

      // Flush microtasks so the first attempt's failure is classified and the
      // retry loop reaches its backoff `setTimeout`, without advancing fake
      // time (the delay's timer must not have fired yet).
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await resultPromise;

      // No further attempt was made after the abort landed mid-backoff.
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends one more real attempt after an abort mid-backoff when buildAbortedError is omitted, matching pre-helper caller behavior", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attempts = 0;

      // No `buildAbortedError` supplied — a caller without a distinct
      // abort-vs-failure error type (e.g. `packages/channels`' client, which
      // throws a plain `Error` either way) must keep spending one more real
      // attempt after an abort lands mid-backoff, exactly as it did before
      // `withHttpRetry` existed, rather than short-circuiting to an error
      // shape only a caller that opted in would produce.
      const resultPromise = withHttpRetry({
        attempt: () => {
          attempts++;
          return Promise.reject(new Error(`attempt ${attempts} failed`));
        },
        timeoutMs: 30_000,
        externalSignal: controller.signal,
        classes: { transient: { maxAttempts: 5 } },
        classify: () => ({ class: "transient" as const }),
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      const error = await resultPromise;

      // The doomed second attempt was made, and its own failure — not a
      // synthesized abort error — is what propagates.
      expect(attempts).toBe(2);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("attempt 2 failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a caller distinguish an external-shutdown abort from an ordinary attempt failure via buildAbortedError", async () => {
    vi.useFakeTimers();
    try {
      class AbortedError extends Error {}
      const controller = new AbortController();

      const resultPromise = withHttpRetry({
        attempt: alwaysFails(new Error("transient failure")),
        timeoutMs: 30_000,
        externalSignal: controller.signal,
        classes: { transient: { maxAttempts: 5 } },
        classify: () => ({ class: "transient" as const }),
        buildAbortedError: () => new AbortedError("aborted by shutdown"),
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      const error = await resultPromise;

      expect(error).toBeInstanceOf(AbortedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the abort listener from the external signal once the call settles — no leak", async () => {
    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

    await withHttpRetry({
      attempt: () => Promise.resolve("ok"),
      timeoutMs: 30_000,
      externalSignal: controller.signal,
      classes: { transient: { maxAttempts: 5 } },
      classify: () => ({ class: "transient" as const }),
    });

    expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // With the listener gone, firing the signal after settlement has no
    // further effect on this already-resolved call.
    expect(() => controller.abort()).not.toThrow();
  });

  it("removes the abort listener even when the attempt fails and is not retried (fatal)", async () => {
    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    const fatalError = new Error("fatal, not retryable");

    await expect(
      withHttpRetry({
        attempt: alwaysFails(fatalError),
        timeoutMs: 30_000,
        externalSignal: controller.signal,
        classes: { transient: { maxAttempts: 5 } },
        classify: (): never => {
          throw fatalError;
        },
      }),
    ).rejects.toBe(fatalError);

    expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("withHttpRetry — error passthrough", () => {
  it("propagates a classify-thrown fatal error unmodified, without wrapping or constructing content of its own", async () => {
    const fatalError = new Error("400: bad request, do not retry");

    await expect(
      withHttpRetry({
        attempt: alwaysFails(fatalError),
        timeoutMs: 30_000,
        classes: { transient: { maxAttempts: 5 } },
        classify: (error): never => {
          throw error;
        },
      }),
    ).rejects.toBe(fatalError);
  });

  it("rethrows the exact classified error on exhaustion when no buildExhaustedError is supplied", async () => {
    vi.useFakeTimers();
    try {
      const theError = new Error("still failing");

      const resultPromise = withHttpRetry({
        attempt: alwaysFails(theError),
        timeoutMs: 30_000,
        classes: { transient: { maxAttempts: 1 } },
        classify: () => ({ class: "transient" as const }),
      }).catch((error: unknown) => error);

      await vi.runAllTimersAsync();
      const error = await resultPromise;

      expect(error).toBe(theError);
    } finally {
      vi.useRealTimers();
    }
  });
});
