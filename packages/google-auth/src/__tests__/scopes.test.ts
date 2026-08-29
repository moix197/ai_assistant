import { describe, expect, it } from "vitest";
import { IDENTITY_SCOPES, SHEETS_SCOPES, hasRequiredScopes, resolveConnectScopes } from "../scopes";

describe("SHEETS_SCOPES", () => {
  it("is the exact single spreadsheets scope", () => {
    expect(SHEETS_SCOPES).toEqual(["https://www.googleapis.com/auth/spreadsheets"]);
  });
});

describe("resolveConnectScopes", () => {
  it("resolves the bare argument to identity scopes alone", () => {
    expect(resolveConnectScopes("")).toEqual(IDENTITY_SCOPES);
  });

  it("resolves 'sheets' to identity plus spreadsheets scopes", () => {
    expect(resolveConnectScopes("sheets")).toEqual([...IDENTITY_SCOPES, ...SHEETS_SCOPES]);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveConnectScopes("  Sheets  ")).toEqual([...IDENTITY_SCOPES, ...SHEETS_SCOPES]);
    expect(resolveConnectScopes("  ")).toEqual(IDENTITY_SCOPES);
  });

  it("returns undefined for an unrecognized argument", () => {
    expect(resolveConnectScopes("nonsense")).toBeUndefined();
    expect(resolveConnectScopes("sheets extra")).toBeUndefined();
  });
});

describe("hasRequiredScopes", () => {
  it("is true only when every required scope is present in granted", () => {
    expect(hasRequiredScopes(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(hasRequiredScopes(["a"], ["a", "b"])).toBe(false);
  });
});
