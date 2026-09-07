import { type Clock, systemClock } from "@hermes/core";
import type { AccessTokenPort } from "./access-token-port";
import type { CalendarClient } from "./calendar-client";

/** Calendar timezone changes are rare — a long TTL trades a little staleness for far fewer Calendar API round trips per read. */
export const TIMEZONE_CACHE_TTL_MS = 6 * 60 * 60_000;

export interface ResolveUserTimeZoneDeps {
  calendarClient: CalendarClient;
  accessTokenPort: AccessTokenPort;
  /** Defaults to `systemClock`; overridden by tests that need control over "now" (mirrors `@hermes/google-auth`'s `RefreshCoordinatorDeps`). */
  clock?: Clock;
}

interface CacheEntry {
  timeZone: string;
  expiresAt: number;
}

/**
 * In-process, keyed by `${channel}:${channelUserId}` — module-level on
 * purpose: "in-process" cache means one cache for the whole process
 * lifetime, not one per call or per `deps` instance.
 */
const cache = new Map<string, CacheEntry>();

function cacheKey(channel: string, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}

/**
 * The timezone source of truth (settled decision 1): the user's primary
 * Google Calendar's own `timeZone` field, cached in-process for
 * `TIMEZONE_CACHE_TTL_MS`. On a cache miss or expiry, fetches an access
 * token and calls `getPrimaryCalendarTimeZone`, then caches the result.
 */
export async function resolveUserTimeZone(
  deps: ResolveUserTimeZoneDeps,
  channel: string,
  channelUserId: string,
  signal?: AbortSignal,
): Promise<string> {
  const clock = deps.clock ?? systemClock;
  const key = cacheKey(channel, channelUserId);
  const now = clock.now().getTime();

  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.timeZone;

  const accessToken = await deps.accessTokenPort.getAccessToken(channel, channelUserId);
  const timeZone = await deps.calendarClient.getPrimaryCalendarTimeZone(accessToken, signal);
  cache.set(key, { timeZone, expiresAt: now + TIMEZONE_CACHE_TTL_MS });
  return timeZone;
}
