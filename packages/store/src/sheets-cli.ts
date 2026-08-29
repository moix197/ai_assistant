/**
 * `hermes-sheets`'s argument parsing, extracted from `bin/sheets.ts` so it is
 * unit-testable without a database or a subprocess — per this phase's own
 * rule against verifying testable logic only by running the CLI end to end.
 * `bin/sheets.ts` stays a thin wrapper: parse here, then call straight into
 * `sheet-registry-repo.ts`'s functions against a short-lived `Pool`.
 */

export const USAGE = `Usage:
  hermes-sheets add <slug> <spreadsheetId> [--desc <text>] [--access read|readwrite] [--value-input-option RAW|USER_ENTERED]
  hermes-sheets list
  hermes-sheets remove <slug>`;

export class CliUsageError extends Error {}

export type ParsedCommand =
  | {
      command: "add";
      slug: string;
      spreadsheetId: string;
      description?: string;
      access?: "read" | "readwrite";
      valueInputOption?: "RAW" | "USER_ENTERED";
    }
  | { command: "list" }
  | { command: "remove"; slug: string };

const ACCESS_VALUES = ["read", "readwrite"] as const;
const VALUE_INPUT_OPTION_VALUES = ["RAW", "USER_ENTERED"] as const;

/**
 * Exhaustive on purpose: a typo'd flag (`--acess`) must be rejected here, not
 * silently dropped on the floor — the exact bug a code review caught live
 * against the test DB (`add typo sid-2 --acess readwrite` exiting 0 with
 * `access=read`, the opposite of what the operator asked for).
 */
const ALLOWED_FLAGS = ["desc", "access", "value-input-option"] as const;

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new CliUsageError(`Unexpected argument "${arg ?? ""}"\n\n${USAGE}`);
    }
    const name = arg.slice(2);
    if (!(ALLOWED_FLAGS as readonly string[]).includes(name)) {
      throw new CliUsageError(`Unknown flag "--${name}"\n\n${USAGE}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Flag --${name} requires a value\n\n${USAGE}`);
    }
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

function parseAdd(rest: string[]): ParsedCommand {
  const [slug, spreadsheetId, ...flagArgs] = rest;
  if (!slug || !spreadsheetId) {
    throw new CliUsageError(`"add" requires <slug> and <spreadsheetId>\n\n${USAGE}`);
  }

  const flags = parseFlags(flagArgs);

  const access = flags.get("access");
  if (access !== undefined && !(ACCESS_VALUES as readonly string[]).includes(access)) {
    throw new CliUsageError(`Invalid --access "${access}" (expected "read" or "readwrite")`);
  }

  const valueInputOption = flags.get("value-input-option");
  if (
    valueInputOption !== undefined &&
    !(VALUE_INPUT_OPTION_VALUES as readonly string[]).includes(valueInputOption)
  ) {
    throw new CliUsageError(
      `Invalid --value-input-option "${valueInputOption}" (expected "RAW" or "USER_ENTERED")`,
    );
  }

  return {
    command: "add",
    slug,
    spreadsheetId,
    description: flags.get("desc"),
    access: access as "read" | "readwrite" | undefined,
    valueInputOption: valueInputOption as "RAW" | "USER_ENTERED" | undefined,
  };
}

export function parseArgs(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;

  if (command === "add") return parseAdd(rest);

  if (command === "list") {
    if (rest.length > 0) throw new CliUsageError(`"list" takes no arguments\n\n${USAGE}`);
    return { command: "list" };
  }

  if (command === "remove") {
    const [slug] = rest;
    if (!slug) throw new CliUsageError(`"remove" requires <slug>\n\n${USAGE}`);
    return { command: "remove", slug };
  }

  throw new CliUsageError(command ? `Unknown command "${command}"\n\n${USAGE}` : USAGE);
}
