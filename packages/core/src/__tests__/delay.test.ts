import { afterEach, describe, expect, it, vi } from "vitest";
import { delay } from "../delay";

afterEach(() => {
  vi.useRealTimers();
});

describe("delay", () => {
  it("resolves only after the given delay when never aborted", async () => {
    vi.useFakeTimers();
    let resolved = false;
    void delay(1_000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    let resolved = false;

    void delay(10_000, controller.signal).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toBe(true);
  });

  it("resolves as soon as the signal aborts mid-sleep, without waiting out the full delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolved = false;
    void delay(10_000, controller.signal).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });
});
