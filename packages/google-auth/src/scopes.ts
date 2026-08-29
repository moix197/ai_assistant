/**
 * The identity scopes every `/connect google` requests — non-sensitive,
 * needing no Google verification review (settled decision 15). No later
 * phase widens what *this* connect flow asks for; a tool that needs more
 * requests its own incremental consent.
 */
export const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

/**
 * The one scope every Sheets tool needs (`sheets_inspect`/`sheets_read`/
 * `sheets_write`, Phase 4/5) — a single incremental-consent unit `/connect
 * google sheets` requests on top of identity, never on its own (Google
 * requires identity for Hermes to know which account it just connected).
 */
export const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** `true` only if every scope in `required` is present in `granted` — a tool never runs on a partial match. */
export function hasRequiredScopes(granted: string[], required: string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

/**
 * Maps a `/connect google` sub-argument to the scopes it requests —
 * `""` (the bare command) to identity alone, `"sheets"` to identity plus
 * `SHEETS_SCOPES`. Case-insensitive and whitespace-trimmed so `"Sheets"` or
 * `" sheets "` still resolve; anything else (a typo, extra words) returns
 * `undefined` so the caller falls back to its usage-help message instead of
 * silently requesting the wrong scopes.
 */
export function resolveConnectScopes(argument: string): string[] | undefined {
  const normalized = argument.trim().toLowerCase();
  if (normalized === "") return IDENTITY_SCOPES;
  if (normalized === "sheets") return [...IDENTITY_SCOPES, ...SHEETS_SCOPES];
  return undefined;
}

/**
 * Which Google scopes a given tool needs, consulted at tool-selection time
 * starting Phase 3. Seeded with `whoami`; `05-google-sheets` Phase 4 adds
 * `sheets_inspect`/`sheets_read`, Phase 5 adds `sheets_write` — the agent
 * can never escalate its own scopes (Dependencies & Risks), so this map is
 * the single place a tool's requirement is declared, never inferred at call
 * time.
 */
export const TOOL_REQUIRED_SCOPES: ReadonlyMap<string, readonly string[]> = new Map([
  ["whoami", IDENTITY_SCOPES],
  ["sheets_inspect", SHEETS_SCOPES],
  ["sheets_read", SHEETS_SCOPES],
  ["sheets_write", SHEETS_SCOPES],
]);
