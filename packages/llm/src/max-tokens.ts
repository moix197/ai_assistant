/**
 * Invariant #9's max-tokens-per-turn guard: bounds a single turn's output
 * spend independently of the monthly ceiling (Phase 4). A single named,
 * exported constant, not a magic number inlined at the call site, so a
 * later phase can override it per-tool without re-deriving the value.
 */
export const MAX_TOKENS_PER_TURN = 1024;
