import type { ApprovalRequest, ApprovalSummary } from "@hermes/agent";

/**
 * The prepare-less/malformed-summary fallback — today's raw-JSON line,
 * unchanged. A `summary` with a falsy `action` (defensive: a well-typed
 * `ApprovalSummary` should never have this, but a `prepare` bug could still
 * produce one at runtime) takes this same path rather than rendering a
 * blank or broken prompt line.
 */
function formatRawFallback(request: ApprovalRequest): string {
  return `- ${request.tool}(${JSON.stringify(request.args)})`;
}

/** `items` (indented two spaces) plus an itemsTotal-driven "…y N más" count line — `null` when there's nothing to show. */
function formatItemsSection(summary: ApprovalSummary): string | null {
  if (!summary.items || summary.items.length === 0) return null;
  const lines = summary.items.map((item) => `  ${item}`);
  if (summary.itemsTotal !== undefined && summary.itemsTotal > summary.items.length) {
    const remaining = summary.itemsTotal - summary.items.length;
    lines.push(`  …y ${remaining} más (${summary.itemsTotal} en total).`);
  }
  return lines.join("\n");
}

/**
 * The legible identity block: `action` (line 1), `target` (line 2, when
 * present), a blank line, the items section (when present), a blank line,
 * then each `effects` entry as its own line. Empty sections are dropped
 * rather than leaving a dangling blank line — a Phase 3 `sheets_write`
 * summary (`effects: []`, no `items`) renders as just the one- or two-line
 * identity block, matching the plan's exact success-criteria example.
 */
function formatSummaryBlock(summary: ApprovalSummary): string {
  const identity = summary.target ? `${summary.action}\n${summary.target}` : summary.action;
  const itemsSection = formatItemsSection(summary);
  const effectsSection = summary.effects.length > 0 ? summary.effects.join("\n") : null;
  return [identity, itemsSection, effectsSection]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

function formatCallBlock(request: ApprovalRequest): string {
  if (!request.summary || !request.summary.action) {
    return formatRawFallback(request);
  }
  return formatSummaryBlock(request.summary);
}

/**
 * Renders a whole batch's prompt body: each call's own block (a legible
 * summary or the raw-JSON fallback), joined by a blank line — no shared
 * trailing question line (see `plans/06-legible-approvals-bounded-reads.md`'s
 * Dependencies & Risks: the Approve/Deny buttons already ask it).
 */
export function formatBatchPrompt(batch: ApprovalRequest[]): string {
  return batch.map(formatCallBlock).join("\n\n");
}

/** The prompt body plus a trailing resolution label, shown once a batch has been answered (or timed out/aborted). */
export function formatResolvedText(batch: ApprovalRequest[], label: string): string {
  return `${formatBatchPrompt(batch)}\n\n${label}`;
}
