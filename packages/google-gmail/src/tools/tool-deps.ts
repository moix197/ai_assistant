import type { AccessTokenPort } from "../access-token-port";
import type { GmailClient } from "../gmail-client";

/**
 * Shared by every Gmail tool factory (`gmail_list_unread`, this phase; later
 * phases' `gmail_search`/`gmail_read_thread`/…) — the real-infra ports
 * `apps/hermes/src/boot.ts`'s `buildGmailDeps` constructs and passes in
 * already-built. **Two** ports, not three: unlike `@hermes/google-sheets`'
 * `SheetsToolDeps`, there is no registry, because there is no reach-gate to
 * enforce (settled decision 7) — mirrors `@hermes/google-calendar`'s
 * `CalendarToolDeps` exactly.
 */
export interface GmailToolDeps {
  accessTokenPort: AccessTokenPort;
  gmailClient: GmailClient;
}

/** The `ToolSpec.handler` ctx every Gmail tool's handler receives — mirrors `@hermes/agent`'s `ToolSpec.handler` ctx shape exactly, same as `SheetsToolContext`/`CalendarToolContext`. */
export interface GmailToolContext {
  signal: AbortSignal;
  channel: string;
  channelUserId: string;
  turnId: string;
}
