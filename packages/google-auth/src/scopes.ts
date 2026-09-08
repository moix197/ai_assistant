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

/**
 * The one scope every Calendar tool needs (`list_events` here; `find_free_slot`/
 * `check_availability`/`create_event`/`reschedule_event`/`cancel_event` in
 * their own later phases) — a single incremental-consent unit `/connect
 * google calendar` requests on top of identity, never on its own (settled
 * decision 4: one broad scope for all six tools, no per-operation split).
 */
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

/**
 * The one scope `gmail_list_unread` needs (this phase); later phases' other
 * read tools (`gmail_search`/`gmail_read_thread`) share it too — a single
 * incremental-consent unit `/connect google gmail` requests on top of
 * identity, never on its own. The `gmail-send` tier's own scope constant
 * lands in a later phase, kept separate so a read-only connection never
 * implicitly grants send.
 */
export const GMAIL_READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * The two scopes gmail_archive/gmail_label need on top of read (Phase 3),
 * and later phases' gmail_draft_reply/gmail_send_draft — granted only by
 * `/connect google gmail-send`, never by `/connect google gmail`. Individual
 * members are re-exported so `TOOL_REQUIRED_SCOPES` rows can declare exactly
 * the one scope a given tool needs (settled decision 1: kept flat and
 * literal, no scope-implication graph), rather than the whole tier.
 */
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_WRITE_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE];

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
  if (normalized === "calendar") return [...IDENTITY_SCOPES, ...CALENDAR_SCOPES];
  if (normalized === "gmail") return [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES];
  if (normalized === "gmail-send") {
    return [...IDENTITY_SCOPES, ...GMAIL_READ_SCOPES, ...GMAIL_WRITE_SCOPES];
  }
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
  ["list_events", CALENDAR_SCOPES],
  ["find_free_slot", CALENDAR_SCOPES],
  ["check_availability", CALENDAR_SCOPES],
  ["create_event", CALENDAR_SCOPES],
  ["reschedule_event", CALENDAR_SCOPES],
  ["cancel_event", CALENDAR_SCOPES],
  ["gmail_list_unread", GMAIL_READ_SCOPES],
  ["gmail_search", GMAIL_READ_SCOPES],
  ["gmail_read_thread", GMAIL_READ_SCOPES],
  // Only `gmail.modify`, not the whole GMAIL_WRITE_SCOPES tier — a tool's
  // declared requirement stays the minimum it actually needs (Phase 3
  // file-changes row).
  ["gmail_archive", [GMAIL_MODIFY_SCOPE]],
  ["gmail_label", [GMAIL_MODIFY_SCOPE]],
  // `drafts.create`/`drafts.update` accept `gmail.modify` per Google's
  // per-method scope table — the write tier already grants it, so this adds
  // no new connect-tier scope (Phase 4 file-changes row).
  ["gmail_draft_reply", [GMAIL_MODIFY_SCOPE]],
]);
