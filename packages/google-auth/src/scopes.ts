/**
 * The identity scopes every `/connect google` requests — non-sensitive,
 * needing no Google verification review (settled decision 15). No later
 * phase widens what *this* connect flow asks for; a tool that needs more
 * requests its own incremental consent.
 */
export const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

/** `true` only if every scope in `required` is present in `granted` — a tool never runs on a partial match. */
export function hasRequiredScopes(granted: string[], required: string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

/**
 * Which Google scopes a given tool needs, consulted at tool-selection time
 * starting Phase 3. Seeded this phase with only `whoami`, the sole
 * Google-backed tool this plan ships — the agent can never escalate its own
 * scopes (Dependencies & Risks), so this map is the single place a tool's
 * requirement is declared, never inferred at call time.
 */
export const TOOL_REQUIRED_SCOPES: ReadonlyMap<string, readonly string[]> = new Map([
  ["whoami", IDENTITY_SCOPES],
]);
