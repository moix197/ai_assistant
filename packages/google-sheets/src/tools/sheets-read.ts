import { z } from "zod/v4";
import { resolveSheet } from "../resolve-sheet";
import type { ValueRenderOption } from "../sheets-client";
import { truncateBySize } from "../truncate";
import type { SheetsToolContext, SheetsToolDeps } from "./tool-deps";

const schema = z.object({
  sheet: z.string(),
  range: z.string(),
  valueRenderOption: z
    .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
    .default("FORMATTED_VALUE"),
});

export type CreateSheetsReadToolDeps = SheetsToolDeps;

/**
 * `sheets_read`: given a registered slug and an A1-notation range, returns
 * the cell values. `valueRenderOption` defaults to `FORMATTED_VALUE` — the
 * agent relays results to a human, so values as a human would see them,
 * matching settled decision 16, not raw numbers/formulas. Any registered
 * `access` value (`read` or `readwrite`) permits a read — only `sheets_write`
 * (Phase 5) checks `access`. Same base/gated split and unknown-slug
 * short-circuit as `sheets_inspect`.
 */
export function createSheetsReadTool(deps: CreateSheetsReadToolDeps) {
  return {
    name: "sheets_read",
    description:
      "Reads cell values from a registered spreadsheet by slug and A1-notation range (e.g. 'Sheet1!A1:D20'). Args: { sheet, range, valueRenderOption? } — valueRenderOption defaults to FORMATTED_VALUE (values as a human would see them).",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: SheetsToolContext): Promise<unknown> => {
      const { sheet, range, valueRenderOption } = args as z.infer<typeof schema>;
      const resolved = await resolveSheet(deps.sheetRegistry, sheet);
      if (!resolved.ok) return resolved;

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      const result = await deps.sheetsClient.getValues(
        accessToken,
        resolved.entry.spreadsheetId,
        range,
        valueRenderOption as ValueRenderOption,
        ctx.signal,
      );
      // `values.get` only returns rows that actually have data — a request
      // for `A1:Z1000` against a 40-row sheet returns 40 rows, not 1000
      // padded with empties — so `totalRows`/`totalColumns` below must be
      // computed from what Google actually returned for this range, never
      // from the requested range's nominal size.
      const values = result.values ?? [];
      const capped = truncateBySize(values, (row) => ({
        cells: row.length,
        chars: JSON.stringify(row).length,
      }));

      return {
        ok: true,
        sheet: resolved.entry.slug,
        range: result.range,
        values: capped.items,
        ...(capped.truncated && {
          truncated: true,
          returnedRows: capped.returnedCount,
          totalRows: capped.totalCount,
          totalColumns: Math.max(0, ...values.map((row) => row.length)),
          note: "El rango es muy grande — pide un rango más chico para ver el resto.",
        }),
      };
    },
  };
}
