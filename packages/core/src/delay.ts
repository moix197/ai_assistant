/**
 * Resolves after `ms`, or as soon as `signal` aborts — whichever comes
 * first. Retry backoff can run as long as `nextDelay`'s `MAX_DELAY_MS`
 * (30s), so a shutdown mid-sleep must not wait that out. Always clears both
 * the timer and the abort listener before resolving, on either path, so
 * nothing leaks per retry attempt. Shared by `packages/llm` and
 * `packages/channels`, both of which sleep between retry attempts against an
 * externally-supplied shutdown signal.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
