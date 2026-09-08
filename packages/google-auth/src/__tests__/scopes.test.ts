import { describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPES,
  GMAIL_READ_SCOPES,
  IDENTITY_SCOPES,
  SHEETS_SCOPES,
  TOOL_REQUIRED_SCOPES,
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

describe("GMAIL_READ_SCOPES", () => {
  it("is the exact single gmail.readonly scope", () => {
    expect(GMAIL_READ_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
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

  it("resolves 'gmail' to identity plus gmail read scopes", () => {
    expect(resolveConnectScopes("gmail")).toEqual([...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES]);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveConnectScopes("  Sheets  ")).toEqual([...IDENTITY_SCOPES, ...SHEETS_SCOPES]);
    expect(resolveConnectScopes("  Calendar  ")).toEqual([...IDENTITY_SCOPES, ...CALENDAR_SCOPES]);
    expect(resolveConnectScopes("  Gmail  ")).toEqual([...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES]);
    expect(resolveConnectScopes("  ")).toEqual(IDENTITY_SCOPES);
  });

  it("returns undefined for an unrecognized argument", () => {
    expect(resolveConnectScopes("nonsense")).toBeUndefined();
    expect(resolveConnectScopes("sheets extra")).toBeUndefined();
    expect(resolveConnectScopes("calendar extra")).toBeUndefined();
    expect(resolveConnectScopes("gmail extra")).toBeUndefined();
  });
});

describe("TOOL_REQUIRED_SCOPES", () => {
  it("has the gmail_list_unread row, requiring the gmail read scopes", () => {
    expect(TOOL_REQUIRED_SCOPES.get("gmail_list_unread")).toEqual(GMAIL_READ_SCOPES);
  });
});

describe("hasRequiredScopes", () => {
  it("is true only when every required scope is present in granted", () => {
    expect(hasRequiredScopes(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(hasRequiredScopes(["a"], ["a", "b"])).toBe(false);
  });
});
