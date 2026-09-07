import { describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPES,
  IDENTITY_SCOPES,
  SHEETS_SCOPES,
  hasRequiredScopes,
  resolveConnectScopes,
} from "../scopes";

describe("SHEETS_SCOPES", () => {
  it("is the exact single spreadsheets scope", () => {
    expect(SHEETS_SCOPES).toEqual(["https://www.googleapis.com/auth/spreadsheets"]);
  });
});

describe("CALENDAR_SCOPES", () => {
  it("is the exact single broad calendar scope", () => {
    expect(CALENDAR_SCOPES).toEqual(["https://www.googleapis.com/auth/calendar"]);
  });
});

describe("resolveConnectScopes", () => {
  it("resolves the bare argument to identity scopes alone", () => {
    expect(resolveConnectScopes("")).toEqual(IDENTITY_SCOPES);
  });

  it("resolves 'sheets' to identity plus spreadsheets scopes", () => {
    expect(resolveConnectScopes("sheets")).toEqual([...IDENTITY_SCOPES, ...SHEETS_SCOPES]);
  });

  it("resolves 'calendar' to identity plus calendar scopes", () => {
    expect(resolveConnectScopes("calendar")).toEqual([...IDENTITY_SCOPES, ...CALENDAR_SCOPES]);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveConnectScopes("  Sheets  ")).toEqual([...IDENTITY_SCOPES, ...SHEETS_SCOPES]);
    expect(resolveConnectScopes("  Calendar  ")).toEqual([...IDENTITY_SCOPES, ...CALENDAR_SCOPES]);
    expect(resolveConnectScopes("  ")).toEqual(IDENTITY_SCOPES);
  });

  it("returns undefined for an unrecognized argument", () => {
    expect(resolveConnectScopes("nonsense")).toBeUndefined();
    expect(resolveConnectScopes("sheets extra")).toBeUndefined();
    expect(resolveConnectScopes("calendar extra")).toBeUndefined();
  });
});

describe("hasRequiredScopes", () => {
  it("is true only when every required scope is present in granted", () => {
    expect(hasRequiredScopes(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(hasRequiredScopes(["a"], ["a", "b"])).toBe(false);
  });
});
