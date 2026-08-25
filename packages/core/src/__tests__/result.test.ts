import { describe, expect, it } from "vitest";
import { type Result, err, ok } from "../result";

describe("Result", () => {
  it("constructs an ok result", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("constructs an err result", () => {
    const result = err(new Error("bad"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("bad");
    }
  });

  it("narrows via the ok discriminant", () => {
    function unwrap<T>(result: Result<T>): T {
      if (!result.ok) throw result.error;
      return result.value;
    }

    expect(unwrap(ok("value"))).toBe("value");
    expect(() => unwrap(err(new Error("nope")))).toThrow("nope");
  });
});
