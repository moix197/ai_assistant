/**
 * Pure allowlist membership check. `TELEGRAM_ALLOWLIST` is validated as a
 * comma-separated list of numeric ids at config-load time
 * (`@hermes/config`'s zod refinement rejects malformed entries at boot), so
 * this trusts its input and only parses it into a lookup set.
 */
export function parseAllowlist(csv: string): Set<number> {
  const trimmed = csv.trim();
  if (trimmed === "") return new Set();
  return new Set(trimmed.split(",").map((entry) => Number(entry.trim())));
}

/** An empty allowlist rejects everyone — fail closed, not fail open. */
export function isAllowed(channelUserId: number, allowlist: Set<number>): boolean {
  return allowlist.has(channelUserId);
}
