import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../sheets-cli";

describe("parseArgs — add", () => {
  it("parses add with every optional flag supplied", () => {
    const parsed = parseArgs([
      "add",
      "clients",
      "spreadsheet-1",
      "--desc",
      "Client roster",
      "--access",
      "readwrite",
      "--value-input-option",
      "RAW",
    ]);

    expect(parsed).toEqual({
      command: "add",
      slug: "clients",
      spreadsheetId: "spreadsheet-1",
      description: "Client roster",
      access: "readwrite",
      valueInputOption: "RAW",
    });
  });

  it("parses add with no optional flags — optional fields are undefined, not JS-side defaulted", () => {
    const parsed = parseArgs(["add", "clients", "spreadsheet-1"]);

    expect(parsed).toEqual({
      command: "add",
      slug: "clients",
      spreadsheetId: "spreadsheet-1",
      description: undefined,
      access: undefined,
      valueInputOption: undefined,
    });
  });

  it("throws when slug is missing", () => {
    expect(() => parseArgs(["add"])).toThrow(CliUsageError);
  });

  it("throws when spreadsheetId is missing", () => {
    expect(() => parseArgs(["add", "clients"])).toThrow(CliUsageError);
  });

  it("rejects an invalid --access value with a clear message, before any DB call could happen", () => {
    expect(() => parseArgs(["add", "clients", "spreadsheet-1", "--access", "admin"])).toThrow(
      /Invalid --access "admin"/,
    );
  });

  it("rejects an invalid --value-input-option value with a clear message", () => {
    expect(() =>
      parseArgs(["add", "clients", "spreadsheet-1", "--value-input-option", "FANCY"]),
    ).toThrow(/Invalid --value-input-option "FANCY"/);
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgs(["add", "clients", "spreadsheet-1", "--access"])).toThrow(CliUsageError);
  });

  it("throws on an unrecognized flag-shaped token", () => {
    expect(() => parseArgs(["add", "clients", "spreadsheet-1", "not-a-flag", "value"])).toThrow(
      CliUsageError,
    );
  });

  it("rejects an unknown flag instead of silently dropping it — the operator-typo repro (--acess)", () => {
    expect(() => parseArgs(["add", "typo", "sid-2", "--acess", "readwrite"])).toThrow(
      /Unknown flag "--acess"/,
    );
  });

  it("rejects a flag-shaped token where a value is expected, instead of swallowing it as the value", () => {
    expect(() =>
      parseArgs(["add", "clients", "spreadsheet-1", "--desc", "--access", "readwrite"]),
    ).toThrow(/Flag --desc requires a value/);
  });
});

describe("parseArgs — list", () => {
  it("parses list with no arguments", () => {
    expect(parseArgs(["list"])).toEqual({ command: "list" });
  });

  it("throws when list is given extra arguments", () => {
    expect(() => parseArgs(["list", "extra"])).toThrow(CliUsageError);
  });
});

describe("parseArgs — remove", () => {
  it("parses remove with a slug", () => {
    expect(parseArgs(["remove", "clients"])).toEqual({ command: "remove", slug: "clients" });
  });

  it("throws when remove is missing a slug", () => {
    expect(() => parseArgs(["remove"])).toThrow(CliUsageError);
  });
});

describe("parseArgs — unknown/missing command", () => {
  it("throws on an unknown command", () => {
    expect(() => parseArgs(["bogus"])).toThrow(/Unknown command "bogus"/);
  });

  it("throws when no command is given", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });
});
