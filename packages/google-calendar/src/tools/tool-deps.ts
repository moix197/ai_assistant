import type { AccessTokenPort } from "../access-token-port";
import type { CalendarClient } from "../calendar-client";

/** Shared by every Calendar tool factory — the real-infra ports `apps/hermes/src/boot.ts`'s `buildCalendarDeps` (Phase 2) constructs and passes in already-built. Mirrors `@hermes/google-sheets`' `SheetsToolDeps` exactly. */
export interface CalendarToolDeps {
  accessTokenPort: AccessTokenPort;
  calendarClient: CalendarClient;
}

/** The `ToolSpec.handler` ctx every Calendar tool's handler receives — mirrors `@hermes/agent`'s `ToolSpec.handler` ctx shape exactly, same as `SheetsToolContext`. */
export interface CalendarToolContext {
  signal: AbortSignal;
  channel: string;
  channelUserId: string;
  turnId: string;
}
