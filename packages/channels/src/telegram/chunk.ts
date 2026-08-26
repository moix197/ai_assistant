const DEFAULT_MAX_LEN = 4096;

function findLastWhitespaceIndex(window: string): number {
  for (let i = window.length - 1; i >= 0; i--) {
    if (/\s/.test(window.charAt(i))) return i;
  }
  return -1;
}

/**
 * Splits `text` into parts no longer than `maxLen`, breaking at the last
 * whitespace character within the window so words aren't cut mid-token. The
 * whitespace character itself stays attached to the end of the part that
 * precedes it (rather than being dropped), so `parts.join("")` always
 * reconstructs the original text exactly. Hard-cuts at `maxLen` only when no
 * whitespace exists anywhere in the window.
 *
 * Not markdown/entity-aware: nothing in this PRD formats output yet (no
 * `parse_mode` is used anywhere), so entity-safe splitting has no caller —
 * see packages/channels/README.md.
 */
export function chunkText(text: string, maxLen: number = DEFAULT_MAX_LEN): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const lastWhitespaceIndex = findLastWhitespaceIndex(window);
    const splitAt = lastWhitespaceIndex === -1 ? maxLen : lastWhitespaceIndex + 1;

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  parts.push(remaining);
  return parts;
}
