import type { Channel } from "@hermes/channels";
import type { Clock, Logger } from "@hermes/core";
import {
  type GoogleAccount,
  REFRESH_SKEW_MS,
  type RefreshCoordinator,
  RefreshFailedError,
} from "@hermes/google-auth";

/**
 * How often the sweep ticks — deliberately half of `REFRESH_SKEW_MS` (10
 * minutes), so one missed or slow tick still leaves a full interval of
 * buffer before a token actually expires.
 */
export const REFRESH_SWEEP_INTERVAL_MS = 5 * 60_000;

const RECONNECT_ALERT_TEXT =
  "Your Google connection needs to be re-established. Run /connect google to reconnect.";

/**
 * The subset of `@hermes/store`'s Google-account functions the sweep needs,
 * bound to a `Pool` at the `boot.ts` construction site — kept narrow rather
 * than the full `GoogleAccountRepo` port (which has no
 * `listAccountsExpiringBefore`/`markDisconnected`; those are free functions
 * `packages/google-auth` itself never needs, since it never lists or bulk-
 * disconnects accounts).
 */
export interface RefreshSweepRepo {
  listAccountsExpiringBefore(cutoff: Date): Promise<GoogleAccount[]>;
  upsertAccount(account: GoogleAccount): Promise<void>;
  markDisconnected(channel: string, channelUserId: string): Promise<void>;
}

export interface RefreshSweepDeps {
  repo: RefreshSweepRepo;
  coordinator: RefreshCoordinator;
  channel: Pick<Channel, "send">;
  clock: Clock;
  logger: Logger;
}

export interface RefreshSweep {
  /**
   * Lists every account expiring within `REFRESH_SKEW_MS` and calls
   * `coordinator.getValidAccessToken` for each — the same seam a future
   * request-path tool call would use, not a separate force-refresh path.
   * A successful refresh persists via `repo.upsertAccount`. A
   * `RefreshFailedError` with `reason: "invalid_grant"` marks the account
   * disconnected and sends a reconnect alert to `account.chatId`; any other
   * failure is logged and the row is left untouched for the next tick. Zero
   * expiring accounts is a no-op, not an error.
   */
  runOnce(): Promise<void>;
  /** Runs `runOnce()` immediately, then every `intervalMs`, until `signal` aborts. */
  start(intervalMs: number, signal: AbortSignal): void;
  /** Stops the interval and awaits whatever `runOnce()` call is currently in flight. */
  stop(): Promise<void>;
}

export function createRefreshSweep(deps: RefreshSweepDeps): RefreshSweep {
  const { repo, coordinator, channel, clock, logger } = deps;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  async function handleRefreshFailure(account: GoogleAccount, error: unknown): Promise<void> {
    if (error instanceof RefreshFailedError && error.reason === "invalid_grant") {
      await repo.markDisconnected(account.channel, account.channelUserId);
      await channel.send(account.chatId, RECONNECT_ALERT_TEXT);
      return;
    }
    logger.warn("refresh sweep: transient refresh failure, will retry next tick", {
      channel: account.channel,
      channelUserId: account.channelUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async function refreshOneAccount(account: GoogleAccount): Promise<void> {
    try {
      const { account: updated } = await coordinator.getValidAccessToken(account);
      await repo.upsertAccount(updated);
    } catch (error) {
      await handleRefreshFailure(account, error);
    }
  }

  async function runOnce(): Promise<void> {
    const cutoff = new Date(clock.now().getTime() + REFRESH_SKEW_MS);
    const accounts = await repo.listAccountsExpiringBefore(cutoff);
    for (const account of accounts) {
      await refreshOneAccount(account);
    }
  }

  function tick(): void {
    inFlight = runOnce().catch((error) => {
      logger.error("refresh sweep: runOnce failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  function start(intervalMs: number, signal: AbortSignal): void {
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
      },
      { once: true },
    );
  }

  async function stop(): Promise<void> {
    clearInterval(timer);
    if (inFlight) await inFlight;
  }

  return { runOnce, start, stop };
}
