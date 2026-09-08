import { describe, expect, it } from "vitest";
import { GmailApiError } from "../gmail-client";
import { toInsufficientScopeResult } from "../insufficient-scope";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const FIX = "run /connect google gmail";

describe("toInsufficientScopeResult", () => {
  it.each([401, 403])(
    "maps a %i GmailApiError to the structured insufficient_scope refusal",
    (status) => {
      const error = new GmailApiError("forbidden", status);

      expect(toInsufficientScopeResult(error, SCOPE, FIX)).toEqual({
        ok: false,
        reason: "insufficient_scope",
        scope: SCOPE,
        fix: FIX,
      });
    },
  );

  it("returns undefined for a GmailApiError with any other status, so the caller rethrows", () => {
    const error = new GmailApiError("server error", 500);

    expect(toInsufficientScopeResult(error, SCOPE, FIX)).toBeUndefined();
  });

  it("returns undefined for a plain Error, so the caller rethrows", () => {
    expect(toInsufficientScopeResult(new Error("boom"), SCOPE, FIX)).toBeUndefined();
  });

  it("returns undefined for a non-Error thrown value, so the caller rethrows", () => {
    expect(toInsufficientScopeResult("boom", SCOPE, FIX)).toBeUndefined();
  });
});
