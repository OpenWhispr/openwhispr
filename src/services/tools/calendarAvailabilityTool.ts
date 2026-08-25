import {
  BUFFER_MINUTES_BOUNDS,
  DEFAULT_BUFFER_MINUTES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MINIMUM_SLOT_MINUTES,
  MAX_AVAILABILITY_HORIZON_DAYS,
  MAX_RESULTS_BOUNDS,
  MINIMUM_SLOT_MINUTES_BOUNDS,
  USER_CORRECTABLE_ERRORS,
  isExplicitOffsetRfc3339,
} from "../../helpers/calendarAvailability";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import type {
  CalendarAvailabilityInterval,
  CalendarAvailabilityRequest,
  CalendarAvailabilityResult,
  CalendarAvailabilitySlot,
} from "../../types/calendar";

const ALLOWED_ARGUMENTS = new Set([
  "start",
  "end",
  "minimumSlotMinutes",
  "bufferMinutes",
  "maxResults",
]);

// Only these known validation messages are relayed; all other IPC errors stay generic.
const RELAYED_ERRORS = new Set<string>(Object.values(USER_CORRECTABLE_ERRORS));

const failure = (displayText: string): ToolResult => ({
  success: false,
  data: null,
  displayText,
});

function parseRequest(args: Record<string, unknown>): CalendarAvailabilityRequest | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (Object.keys(args).some((key) => !ALLOWED_ARGUMENTS.has(key))) return null;

  const start = typeof args.start === "string" ? args.start.trim() : "";
  const end = typeof args.end === "string" ? args.end.trim() : "";
  if (!isExplicitOffsetRfc3339(start) || !isExplicitOffsetRfc3339(end)) return null;
  if (Date.parse(start) >= Date.parse(end)) return null;

  const request: CalendarAvailabilityRequest = { start, end };
  for (const [key, bounds] of [
    ["minimumSlotMinutes", MINIMUM_SLOT_MINUTES_BOUNDS],
    ["bufferMinutes", BUFFER_MINUTES_BOUNDS],
    ["maxResults", MAX_RESULTS_BOUNDS],
  ] as const) {
    const value = args[key];
    // Models often send explicit null for optional arguments; the service's
    // ?? defaults treat null as absent, so accept it here too.
    if (value === undefined || value === null) continue;
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < bounds.minimum ||
      (value as number) > bounds.maximum
    ) {
      return null;
    }
    request[key] = value as number;
  }

  return request;
}

function toInterval(value: unknown): CalendarAvailabilityInterval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { start, end } = value as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return { start, end };
}

// Projects the IPC payload onto known privacy-safe fields; anything malformed fails closed.
function projectAvailability(value: unknown): CalendarAvailabilityResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const range = toInterval(payload.range);
  const lookaheadDays =
    payload.coverage && typeof payload.coverage === "object"
      ? (payload.coverage as Record<string, unknown>).lookaheadDays
      : null;
  if (
    !range ||
    typeof payload.timezone !== "string" ||
    !payload.timezone ||
    typeof payload.hasMore !== "boolean" ||
    typeof payload.isEntireRangeFree !== "boolean" ||
    !Array.isArray(payload.availableSlots) ||
    !Number.isSafeInteger(lookaheadDays) ||
    (lookaheadDays as number) < 1
  ) {
    return null;
  }

  const availableSlots: CalendarAvailabilitySlot[] = [];
  for (const item of payload.availableSlots) {
    const interval = toInterval(item);
    const durationMinutes = (item as Record<string, unknown> | null)?.durationMinutes;
    if (!interval || !Number.isSafeInteger(durationMinutes) || (durationMinutes as number) < 1) {
      return null;
    }
    availableSlots.push({ ...interval, durationMinutes: durationMinutes as number });
  }

  return {
    range,
    timezone: payload.timezone,
    availableSlots,
    hasMore: payload.hasMore,
    isEntireRangeFree: payload.isEntireRangeFree,
    coverage: { source: "local-calendar-cache", lookaheadDays: lookaheadDays as number },
  };
}

function localizeInstant(
  instant: string,
  formatter: Intl.DateTimeFormat
): { date: string; weekday: string; time: string; timeZoneName: string } {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
    timeZoneName: parts.timeZoneName,
  };
}

function toModelFacts(
  availability: CalendarAvailabilityResult,
  request: CalendarAvailabilityRequest
): Record<string, unknown> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: availability.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "shortOffset",
  });

  return {
    type: "calendar_availability_facts",
    timezone: availability.timezone,
    query: {
      start: localizeInstant(availability.range.start, formatter),
      end: localizeInstant(availability.range.end, formatter),
      minimumSlotMinutes: request.minimumSlotMinutes ?? DEFAULT_MINIMUM_SLOT_MINUTES,
      bufferMinutes: request.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
      maxResults: request.maxResults ?? DEFAULT_MAX_RESULTS,
    },
    slotCount: availability.availableSlots.length,
    availableSlots: availability.availableSlots.map((slot) => ({
      start: localizeInstant(slot.start, formatter),
      end: localizeInstant(slot.end, formatter),
      durationMinutes: slot.durationMinutes,
    })),
    hasMore: availability.hasMore,
    isEntireRangeFree: availability.isEntireRangeFree,
    coverage: availability.coverage,
  };
}

export const calendarAvailabilityTool: ToolDefinition = {
  name: "get_calendar_availability",
  description: `Find open time slots in the local cache for the user's selected connected calendars within the next ${MAX_AVAILABILITY_HORIZON_DAYS} local calendar days. Returns authoritative localized slot facts, never event titles, attendees, or meeting links.`,
  parameters: {
    type: "object",
    properties: {
      start: {
        type: "string",
        format: "date-time",
        description:
          "Inclusive range start as an RFC3339 timestamp with Z or an explicit UTC offset.",
      },
      end: {
        type: "string",
        format: "date-time",
        description: `Exclusive range end as an RFC3339 timestamp with Z or an explicit UTC offset. The service limits end plus buffer to ${MAX_AVAILABILITY_HORIZON_DAYS} local calendar days from the current time.`,
      },
      minimumSlotMinutes: {
        type: "integer",
        ...MINIMUM_SLOT_MINUTES_BOUNDS,
        description: `Minimum duration of a returned free slot in minutes (default ${DEFAULT_MINIMUM_SLOT_MINUTES}).`,
      },
      bufferMinutes: {
        type: "integer",
        ...BUFFER_MINUTES_BOUNDS,
        description: `Minutes to reserve before and after each busy interval (default ${DEFAULT_BUFFER_MINUTES}).`,
      },
      maxResults: {
        type: "integer",
        ...MAX_RESULTS_BOUNDS,
        description: `Maximum number of available slots to return (default ${DEFAULT_MAX_RESULTS}).`,
      },
    },
    required: ["start", "end"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const request = parseRequest(args);
    if (!request) {
      return failure(
        "Invalid calendar availability request. Use supported options and timezone-aware start and end times."
      );
    }

    const getAvailability = window.electronAPI.calendarGetAvailability;
    if (!getAvailability) return failure("Calendar availability is unavailable");

    try {
      const response = await getAvailability(request);
      if (!response?.success) {
        const error = response && response.success === false ? response.error : "";
        return failure(RELAYED_ERRORS.has(error) ? error : "Failed to fetch calendar availability");
      }

      const availability = projectAvailability(response.availability);
      if (!availability) return failure("Failed to fetch calendar availability");

      const count = availability.availableSlots.length;
      const displayText =
        count === 0
          ? "No available time slots meet the requested minimum duration"
          : availability.isEntireRangeFree
            ? "No scheduled conflicts found in the requested range"
            : `Found ${count} available time slot${count === 1 ? "" : "s"}`;

      return { success: true, data: toModelFacts(availability, request), displayText };
    } catch {
      return failure("Failed to fetch calendar availability");
    }
  },
};
