import { type Clock, systemClock } from "@hermes/core";
import { z } from "zod/v4";
import { type RelativeTimeIntent, resolveRelativeWindow } from "../relative-time";
import { renderEventTime } from "../render-event-time";
import { resolveUserTimeZone } from "../timezone-cache";
import { validateTimeWindow } from "../window-bounds";
import type { CalendarToolContext, CalendarToolDeps } from "./tool-deps";

const RELATIVE_DAY = ["today", "tomorrow", "yesterday", "this_week", "next_week"] as const;
const WEEKDAY = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const TIME_OF_DAY = ["morning", "afternoon", "evening", "night"] as const;

const schema = z
  .object({
    relativeDay: z.enum(RELATIVE_DAY).optional(),
    weekday: z.enum(WEEKDAY).optional(),
    timeOfDay: z.enum(TIME_OF_DAY).optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  })
  .strict();

type Args = z.infer<typeof schema>;

/** The description-truncation cap — a lightweight, single-field guard (Context: `maxResults` already bounds the list itself, so the full dual-cap `truncateBySize` accumulator isn't needed here). */
const DESCRIPTION_TRUNCATE_LENGTH = 500;
const DESCRIPTION_TRUNCATE_MARKER = "… (truncado)";

export type CreateCalendarListEventsToolDeps = CalendarToolDeps & {
  /** Defaults to `systemClock`; overridden by tests for a deterministic "now" when resolving a relative-time intent. */
  clock?: Clock;
};

function truncateDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  if (description.length <= DESCRIPTION_TRUNCATE_LENGTH) return description;
  return `${description.slice(0, DESCRIPTION_TRUNCATE_LENGTH)}${DESCRIPTION_TRUNCATE_MARKER}`;
}

/**
 * Resolves the query window: explicit `startIso`/`endIso` win outright when
 * both are given; otherwise the intent fields (`relativeDay`/`weekday`/
 * `timeOfDay`) resolve via `resolveRelativeWindow`, defaulting to
 * `{ relativeDay: "today" }` when none of the three intent fields were
 * given either.
 */
function resolveWindow(
  args: Args,
  nowUtcIso: string,
  timeZone: string,
): { startUtc: string; endUtc: string } {
  if (args.startIso !== undefined && args.endIso !== undefined) {
    return { startUtc: args.startIso, endUtc: args.endIso };
  }

  const hasIntent =
    args.relativeDay !== undefined || args.weekday !== undefined || args.timeOfDay !== undefined;
  const intent: RelativeTimeIntent = hasIntent
    ? { relativeDay: args.relativeDay, weekday: args.weekday, timeOfDay: args.timeOfDay }
    : { relativeDay: "today" };
  return resolveRelativeWindow(intent, nowUtcIso, timeZone);
}

/**
 * `list_events`: ungated read — no `prepare`, no Google call needed to
 * decide whether to run it (the scope gate alone protects it, wired in
 * `apps/hermes/src/agent/build-agent.ts`). Resolves the user's timezone
 * (`resolveUserTimeZone`), resolves and validates the query window
 * (`validateTimeWindow`, settled per the plan's Dependencies & Risks —
 * "unbounded window risk") before ever calling `calendarClient.listEvents`,
 * and renders each returned event's `start`/`end` via `renderEventTime` so
 * an all-day event never crashes attempting to parse a missing `dateTime`.
 * `id` is always present on a returned event — it's the only handle a later
 * `reschedule_event`/`cancel_event` call has for "which event."
 */
export function createCalendarListEventsTool(deps: CreateCalendarListEventsToolDeps) {
  return {
    name: "list_events",
    description:
      "Lists events on the user's primary Google Calendar within a resolved time window. Args: { relativeDay?, weekday?, timeOfDay?, startIso?, endIso?, maxResults? } — relativeDay/weekday/timeOfDay resolve a window deterministically (defaults to today when none are given); startIso+endIso together override them outright. maxResults defaults to 20, max 50.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: false,
    handler: async (args: unknown, ctx: CalendarToolContext): Promise<unknown> => {
      const parsed = args as Args;
      const clock = deps.clock ?? systemClock;

      const timeZone = await resolveUserTimeZone(deps, ctx.channel, ctx.channelUserId, ctx.signal);
      const nowUtcIso = clock.now().toISOString();
      const { startUtc, endUtc } = resolveWindow(parsed, nowUtcIso, timeZone);

      const windowCheck = validateTimeWindow(startUtc, endUtc);
      if (!windowCheck.ok) return { ok: false, reason: windowCheck.reason };

      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);
      const events = await deps.calendarClient.listEvents(
        accessToken,
        { timeMinIso: startUtc, timeMaxIso: endUtc, maxResults: parsed.maxResults },
        ctx.signal,
      );

      return {
        ok: true,
        timeZone,
        range: { startUtc, endUtc },
        events: events.map((event) => ({
          id: event.id,
          summary: event.summary,
          ...(truncateDescription(event.description) !== undefined && {
            description: truncateDescription(event.description),
          }),
          ...renderEventTime(event, timeZone),
        })),
      };
    },
  };
}
