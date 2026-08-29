import { z } from "zod/v4";
import type { AccessTokenPort } from "../access-token-port";
import { resolveSheet } from "../resolve-sheet";
import type { SheetRegistryPort } from "../sheet-registry-port";
import type { SheetMeta, SheetsClient } from "../sheets-client";

const schema = z.object({ sheet: z.string() });

export interface CreateSheetsInspectToolDeps {
  sheetRegistry: SheetRegistryPort;
  accessTokenPort: AccessTokenPort;
  sheetsClient: SheetsClient;
}

interface SheetTabSummary {
  title: string;
  sheetId: number;
  rowCount?: number;
  columnCount?: number;
  /** The first row's formatted cell values, if any — lets the model orient before reading/writing without a separate call. */
  headerRow: string[];
}

function summarizeTabs(meta: SheetMeta): SheetTabSummary[] {
  return meta.sheets.map((sheet) => ({
    title: sheet.properties.title,
    sheetId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties?.rowCount,
    columnCount: sheet.properties.gridProperties?.columnCount,
    headerRow: (sheet.data?.[0]?.rowData?.[0]?.values ?? []).map(
      (cell) => cell.formattedValue ?? "",
    ),
  }));
}

/**
 * `sheets_inspect`: given a registered slug, returns each tab's name,
 * dimensions, and header row, so the model can orient before reading or
 * writing. This is the *base*, ungated tool — `apps/hermes/src/agent/
 * build-agent.ts` wraps it in `withRequiredScopes`, the same split
 * `whoami` uses (the capability lives here, the gate lives in
 * `apps/hermes`). An unknown slug (including an empty registry) short-circuits
 * before any Sheets API call — `resolveSheet`'s shared shape is returned
 * directly.
 */
export function createSheetsInspectTool(deps: CreateSheetsInspectToolDeps) {
  return {
    name: "sheets_inspect",
    description:
      "Inspects a registered spreadsheet by its slug: returns each tab's name, dimensions, and header row, so you can orient before reading or writing. Args: { sheet: the operator-registered slug }.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (
      args: unknown,
      ctx: { signal: AbortSignal; channel: string; channelUserId: string; turnId: string },
    ): Promise<unknown> => {
      const { sheet } = args as z.infer<typeof schema>;
      const resolved = await resolveSheet(deps.sheetRegistry, sheet);
      if (!resolved.ok) return resolved;

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      const meta = await deps.sheetsClient.getSpreadsheetMeta(
        accessToken,
        resolved.entry.spreadsheetId,
        ctx.signal,
      );
      return { ok: true, sheet: resolved.entry.slug, tabs: summarizeTabs(meta) };
    },
  };
}
