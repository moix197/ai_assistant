import type { AccessTokenPort } from "../access-token-port";
import type { SheetRegistryPort } from "../sheet-registry-port";
import type { SheetsClient } from "../sheets-client";

/**
 * Shared by every Sheets tool factory (`sheets_inspect`, `sheets_read`, …
 * Phase 5's `sheets_write`) — the three real-infra ports `apps/hermes/src/
 * boot.ts`'s `buildSheetsDeps` constructs and passes in already-built.
 * `sheets-inspect.ts`/`sheets-read.ts` alias their own `Create*ToolDeps`
 * exports to this rather than duplicating the same three fields.
 */
export interface SheetsToolDeps {
  sheetRegistry: SheetRegistryPort;
  accessTokenPort: AccessTokenPort;
  sheetsClient: SheetsClient;
}

/** The `ToolSpec.handler` ctx every Sheets tool's handler receives — mirrors `@hermes/agent`'s `ToolSpec.handler` ctx shape exactly. */
export interface SheetsToolContext {
  signal: AbortSignal;
  channel: string;
  channelUserId: string;
  turnId: string;
}
