import { type Clock, systemClock } from "@hermes/core";
import { z } from "zod/v4";
import { CalendarApiError } from "../calendar-client";
import { deriveEventId } from "../deterministic-event-id";
import { formatApprovalTimeRangeEs } from "../format-approval-time";
import { type RelativeTimeIntent, resolveRelativeInstant } from "../relative-time";
import { resolveUserTimeZone } from "../timezone-cache";
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
    summary: z.string().min(1),
    description: z.string().optional(),
    relativeDay: z.enum(RELATIVE_DAY).optional(),
    weekday: z.enum(WEEKDAY).optional(),
    timeOfDay: z.enum(TIME_OF_DAY).optional(),
    startIso: z.string().optional(),
    durationMinutes: z.number().int().min(5).max(1440).default(60),
    endIso: z.string().optional(),
  })
  .strict();

type Args = z.infer<typeof schema>;

export type CreateCalendarCreateEventToolDeps = CalendarToolDeps & {
  /** Defaults to `systemClock`; overridden by tests for a deterministic "now" when resolving a relative-time intent. */
  clock?: Clock;
};

/**
 * What `prepare` resolves and threads onto `ctx.plan` for `handler` — no
 * Google call is needed to build it, so it's derivable entirely from `args`,
 * `ctx.turnId`, and the resolved timezone. `eventId` is the client-supplied
 * idempotency id (`deriveEventId`, settled decision 6, corrected — see
 * `.ai/decisions/calendar-event-idempotency.md`).
 */
export interface CreateEventPlan {
  eventId: string;
  summary: string;
  description?: string;
  /** UTC ISO instant. */
  startUtc: string;
  /** UTC ISO instant. */
  endUtc: string;
}

/**
 * Resolves the new event's start instant: explicit `startIso` wins outright;
 * otherwise the intent fields (`relativeDay`/`weekday`/`timeOfDay`) resolve
 * via `resolveRelativeInstant` — an empty intent resolves to today at
 * `resolveRelativeInstant`'s own default hour (09:00 local), the same
 * "no intent given" fallback `list_events`/`find_free_slot` use for their
 * windows.
 */
function resolveStartUtc(args: Args, nowUtcIso: string, timeZone: string): string {
  if (args.startIso !== undefined) return args.startIso;

  const hasIntent =
    args.relativeDay !== undefined || args.weekday !== undefined || args.timeOfDay !== undefined;
  const intent: RelativeTimeIntent = hasIntent
    ? { relativeDay: args.relativeDay, weekday: args.weekday, timeOfDay: args.timeOfDay }
    : {};
  return resolveRelativeInstant(intent, nowUtcIso, timeZone);
}

/** Resolves the new event's end instant: explicit `endIso` wins outright; otherwise `startUtc + durationMinutes`. */
function resolveEndUtc(args: Args, startUtc: string): string {
  if (args.endIso !== undefined) return args.endIso;
  const startMs = new Date(startUtc).getTime();
  return new Date(startMs + args.durationMinutes * 60_000).toISOString();
}

/**
 * `prepare(args, ctx)`: resolves the user's timezone, the requested
 * `startUtc`/`endUtc`, and derives `eventId` — no Google call, everything
 * needed is already resolvable locally (settled decision 3: `create_event`
 * needs no pre-read, nothing exists yet). Builds the Spanish
 * `ApprovalSummary` the approval gate shows before a human ever sees
 * anything: `target` uses `formatApprovalTimeRangeEs` for a legible Spanish
 * date/time label — a non-technical user approves a real write off this
 * string, so it must read as a sentence, not `renderEventTime`'s ISO-based
 * `localLabel` (correct for `list_events`/`find_free_slot`'s tool-result
 * JSON, wrong for this human-facing summary).
 */
async function prepareCreateEvent(
  deps: CreateCalendarCreateEventToolDeps,
  args: unknown,
  ctx: CalendarToolContext,
): Promise<{
  ok: true;
  plan: CreateEventPlan;
  summary: { action: string; target?: string; effects: string[] };
}> {
  const parsed = args as Args;
  const clock = deps.clock ?? systemClock;

  const timeZone = await resolveUserTimeZone(deps, ctx.channel, ctx.channelUserId, ctx.signal);
  const nowUtcIso = clock.now().toISOString();
  const startUtc = resolveStartUtc(parsed, nowUtcIso, timeZone);
  const endUtc = resolveEndUtc(parsed, startUtc);
  const eventId = deriveEventId(ctx.turnId, { summary: parsed.summary, startUtc, endUtc });

  return {
    ok: true,
    plan: { eventId, summary: parsed.summary, description: parsed.description, startUtc, endUtc },
    summary: {
      action: `Crear evento: "${parsed.summary}"`,
      target: formatApprovalTimeRangeEs(startUtc, endUtc, timeZone),
      effects: ["Se creará un evento nuevo en tu calendario principal."],
    },
  };
}

/**
 * `create_event`: `requiresApproval: true` — every call routes through the
 * approval gate before `handler` ever runs. `handler` calls
 * `calendarClient.insertEvent` with `plan.eventId` as the caller-supplied
 * idempotency id; a `409 Conflict` (the id was already inserted — either the
 * model emitted two identical `create_event` calls in the same turn, or
 * `calendar-client.ts` transparently retried an ambiguous insert failure,
 * see `.ai/decisions/calendar-event-idempotency.md`) is treated as
 * already-created: fetches and returns the existing event via `getEvent`
 * instead of erroring. Any other error propagates unchanged.
 */
export function createCalendarCreateEventTool(deps: CreateCalendarCreateEventToolDeps) {
  return {
    name: "create_event",
    description:
      "Creates a new event on the user's primary Google Calendar. Args: { summary, description?, relativeDay?, weekday?, timeOfDay?, startIso?, durationMinutes?, endIso? } — startIso wins outright over the intent fields for the start time (defaults to today's morning when neither is given); endIso wins outright over durationMinutes (default 60 minutes, min 5, max 1440) for the end time. Requires human approval.",
    schema,
    timeoutMs: 30_000,
    requiresApproval: true,
    prepare: (args: unknown, ctx: CalendarToolContext) => prepareCreateEvent(deps, args, ctx),
    handler: async (
      args: unknown,
      ctx: CalendarToolContext & { plan: CreateEventPlan },
    ): Promise<unknown> => {
      const { plan } = ctx;
      const accessToken = await deps.accessTokenPort.getAccessToken(ctx.channel, ctx.channelUserId);

      try {
        return await deps.calendarClient.insertEvent(
          accessToken,
          {
            id: plan.eventId,
            summary: plan.summary,
            description: plan.description,
            start: plan.startUtc,
            end: plan.endUtc,
          },
          ctx.signal,
        );
      } catch (error) {
        if (error instanceof CalendarApiError && error.status === 409) {
          return deps.calendarClient.getEvent(accessToken, plan.eventId, ctx.signal);
        }
        throw error;
      }
    },
  };
}
