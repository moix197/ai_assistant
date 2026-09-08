/**
 * Cuts a message body at the first quote boundary — an "On … wrote:" / "El
 * … escribió:" attribution line, a run of `>`-prefixed lines, a
 * `-----Original Message-----` separator, or a `--` signature separator.
 * **Always returns at least the first non-empty paragraph**, never an empty
 * string: a false-positive boundary that eats the entire message (e.g. one
 * whose very first line happens to match an attribution pattern) is worse
 * than one that leaves quoted history in, so that case falls back to the
 * original text's first paragraph instead of collapsing to nothing.
 */

const ATTRIBUTION_PATTERNS = [/^on .+ wrote:\s*$/i, /^el .+ escribi[oó]:\s*$/i];

function isQuoteBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) return true;
  if (/^--\s?$/.test(line)) return true;
  if (/^>/.test(trimmed)) return true;
  return false;
}

function firstNonEmptyParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed !== "") return trimmed;
  }
  return text.trim();
}

export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  let cutIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isQuoteBoundaryLine(line)) {
      cutIndex = i;
      break;
    }
  }

  const candidate = lines
    .slice(0, cutIndex)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (candidate !== "") return candidate;

  return firstNonEmptyParagraph(text);
}
