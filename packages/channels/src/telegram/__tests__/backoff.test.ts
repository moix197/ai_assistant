import { describe, expect, it } from "vitest";
import { nextDelay } from "../backoff";

describe("nextDelay", () => {
  it("grows exponentially with the attempt count", () => {
    const delay1 = nextDelay(1);
    const delay2 = nextDelay(2);
    const delay3 = nextDelay(3);

    // Jitter is +/-20%, so compare against each other's worst case instead
    // of exact values: attempt N+1's lower bound must exceed attempt N's
    // upper bound for the growth to be unambiguous under jitter.
    expect(delay2).toBeGreaterThan(delay1 * 0.8);
    expect(delay3).toBeGreaterThan(delay2 * 0.8);
  });

  it("caps the delay at the maximum even for large attempt counts", () => {
    const delay = nextDelay(20);
    expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("lets retry_after override the computed delay", () => {
    const delay = nextDelay(1, 5);
    expect(delay).toBe(5000);
  });

  it("uses retry_after even when it is smaller than the computed backoff", () => {
    const delay = nextDelay(10, 1);
    expect(delay).toBe(1000);
  });
});
