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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  /**
   * UPDATE-only rather than `upsertAccount`: the sweep holds a snapshot read
   * one HTTP round-trip ago, so an upsert would resurrect a row `/disconnect`
   * deleted in the meantime and overwrite scopes a `/connect` just granted.
   */
  updateRefreshedTokens(account: GoogleAccount): Promise<void>;
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
   * A successful refresh persists via `repo.updateRefreshedTokens`. A
   * `RefreshFailedError` with `reason: "invalid_grant"` marks the account
   * disconnected and sends a reconnect alert to `account.chatId`; any other
   * failure is logged and the row is left untouched for the next tick. Zero
   * expiring accounts is a no-op, not an error, and no single account's
   * failure — including a failing alert send — skips the accounts after it.
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

  async function alertReconnectNeeded(account: GoogleAccount): Promise<void> {
    try {
      await channel.send(account.chatId, RECONNECT_ALERT_TEXT);
    } catch (error) {
      // Isolated from `markDisconnected` so a blocked bot (Telegram 403) does
      // not make an already-committed disconnect look like it failed.
      logger.error("refresh sweep: could not deliver the reconnect alert", {
        channel: account.channel,
        channelUserId: account.channelUserId,
        error: errorMessage(error),
      });
    }
  }

  async function disconnectAndAlert(account: GoogleAccount, reason: string): Promise<void> {
    logger.warn("refresh sweep: refresh failed terminally, disconnecting account", {
      channel: account.channel,
      channelUserId: account.channelUserId,
      reason,
    });
    await repo.markDisconnected(account.channel, account.channelUserId);
    await alertReconnectNeeded(account);
  }

  async function handleRefreshFailure(account: GoogleAccount, error: unknown): Promise<void> {
    if (error instanceof RefreshFailedError && error.reason === "invalid_grant") {
      await disconnectAndAlert(account, error.reason);
      return;
    }
    logger.warn("refresh sweep: transient refresh failure, will retry next tick", {
      channel: account.channel,
      channelUserId: account.channelUserId,
      error: errorMessage(error),
    });
  }

  async function refreshOneAccount(account: GoogleAccount): Promise<void> {
    try {
      const { account: updated } = await coordinator.getValidAccessToken(account);
      await repo.updateRefreshedTokens(updated);
    } catch (error) {
      // Nothing below may escape: one account's failure — even a failure while
      // handling that failure — must not skip every account after it in the tick.
      try {
        await handleRefreshFailure(account, error);
      } catch (handlingError) {
        logger.error("refresh sweep: handling a refresh failure itself failed", {
          channel: account.channel,
          channelUserId: account.channelUserId,
          error: errorMessage(handlingError),
        });
      }
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
    if (inFlight) {
      // Overlapping ticks would also leave `stop()` awaiting only the newest
      // one, so it could return — and `boot.ts` end the pool — while an older
      // tick still had queries out.
      logger.warn("refresh sweep: previous tick still running, skipping this one");
      return;
    }
    inFlight = runOnce()
      .catch((error) => {
        logger.error("refresh sweep: runOnce failed", {
          error: errorMessage(error),
        });
      })
      .finally(() => {
        inFlight = undefined;
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
