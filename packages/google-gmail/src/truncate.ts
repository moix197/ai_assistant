/**
 * Gmail-local `truncateBySize`, mirroring `packages/google-sheets/src/
 * truncate.ts`'s contract exactly (accumulate in order, stop *before*
 * exceeding either cap, always keep at least one item, additive result
 * shape) — kept package-local rather than promoted to `@hermes/core`
 * (deliberate non-promotion recorded in `.ai/decisions/`, Phase 6's
 * third-caller trigger). Package-internal constants, not env-configurable,
 * same posture as `MAX_CELLS`/`MAX_VALUE_CHARS`.
 */
export const MAX_THREAD_MESSAGES = 10;
export const MAX_BODY_CHARS_PER_MESSAGE = 2_000;

export interface TruncateBySizeCaps {
  maxMessages: number;
  maxChars: number;
}

export interface TruncateBySizeResult<T> {
  items: T[];
  truncated: boolean;
  returnedCount: number;
  totalCount: number;
}

/**
 * Accumulates `items` in order, stopping *before* a would-be-added item
 * would push either running total (`messages` or `chars`) over its cap —
 * except the first item is always kept, so a single oversized item is
 * still returned whole rather than dropped or split.
 */
export function truncateBySize<T>(
  items: T[],
  measure: (item: T) => { messages: number; chars: number },
  caps: TruncateBySizeCaps = {
    maxMessages: MAX_THREAD_MESSAGES,
    maxChars: MAX_THREAD_MESSAGES * MAX_BODY_CHARS_PER_MESSAGE,
  },
): TruncateBySizeResult<T> {
  const kept: T[] = [];
  let messages = 0;
  let chars = 0;
  let truncated = false;

  for (const item of items) {
    const size = measure(item);
    const wouldExceed =
      messages + size.messages > caps.maxMessages || chars + size.chars > caps.maxChars;
    if (wouldExceed) {
      if (kept.length === 0) {
        kept.push(item);
        messages += size.messages;
        chars += size.chars;
      }
      truncated = true;
      break;
    }

    kept.push(item);
    messages += size.messages;
    chars += size.chars;
  }

  return {
    items: kept,
    truncated,
    returnedCount: kept.length,
    totalCount: items.length,
  };
}

/** The `truncateBySize` `measure` callback shape every caller in this package uses — one message, with a caller-supplied char count. */
export function measureMessage(chars: number): { messages: number; chars: number } {
  return { messages: 1, chars };
}
