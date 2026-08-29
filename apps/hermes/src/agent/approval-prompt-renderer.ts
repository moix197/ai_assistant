import type { ApprovalRequest, ApprovalSummary } from "@hermes/agent";

/**
 * Pre-Phase-3's header line, restored verbatim (finding 5 of the Phase 3
 * code review): the plan sanctioned dropping *only* the trailing "Approve or
 * deny?" question line from the old format (the buttons already ask it) —
 * never this header. Used only by the fallback batch format below.
 */
const FALLBACK_HEADER = "The model wants to run:";

/**
 * The prepare-less/malformed-summary fallback line — today's raw-JSON line,
 * unchanged. A `summary` with a falsy `action` (defensive: a well-typed
 * `ApprovalSummary` should never have this, but a `prepare` bug could still
 * produce one at runtime) takes this same path rather than rendering a
 * blank or broken prompt line.
 */
function formatRawFallbackLine(request: ApprovalRequest): string {
  return `- ${request.tool}(${JSON.stringify(request.args)})`;
}

/** A usable summary is one `prepare` actually populated — a falsy `action` is treated as "no summary". */
function hasUsableSummary(request: ApprovalRequest): boolean {
  return Boolean(request.summary?.action);
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

/**
 * Pre-Phase-3's raw-JSON batch format, header included, minus only the
 * trailing "Approve or deny?" question line (finding 5). Used for the whole
 * batch whenever ANY call in it lacks a usable summary — a batch renders in
 * one consistent style or the other, never a jumble of legible Spanish prose
 * and raw-JSON lines in the same prompt.
 */
function formatFallbackBatch(batch: ApprovalRequest[]): string {
  return [FALLBACK_HEADER, ...batch.map(formatRawFallbackLine)].join("\n");
}

/**
 * The generic summary rendering — used only when every call in the batch
 * resolved a usable `ApprovalSummary`. Headerless (matches the plan's
 * worked example): each call's own legible block, joined by a blank line
 * when the batch has more than one.
 */
function formatSummaryBatch(batch: ApprovalRequest[]): string {
  return batch
    .map((request) => formatSummaryBlock(request.summary as ApprovalSummary))
    .join("\n\n");
}

/**
 * Renders a whole batch's prompt body. All-summary batches get the new,
 * headerless generic rendering; a batch with any prepare-less or malformed
 * call falls back, as a whole, to the pre-Phase-3 raw-JSON format (header
 * included, minus the trailing question line) rather than mixing the two
 * styles in one prompt.
 */
export function formatBatchPrompt(batch: ApprovalRequest[]): string {
  return batch.every(hasUsableSummary) ? formatSummaryBatch(batch) : formatFallbackBatch(batch);
}

/** The prompt body plus a trailing resolution label, shown once a batch has been answered (or timed out/aborted). */
export function formatResolvedText(batch: ApprovalRequest[], label: string): string {
  return `${formatBatchPrompt(batch)}\n\n${label}`;
}
