import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import type {
  CalendarAvailabilityInterval,
  CalendarAvailabilityRequest,
  CalendarAvailabilityResult,
  CalendarAvailabilitySlot,
} from "../../types/calendar";

const MINIMUM_SLOT_MINUTES = { minimum: 5, maximum: 480 } as const;
const BUFFER_MINUTES = { minimum: 0, maximum: 120 } as const;
const MAX_RESULTS = { minimum: 1, maximum: 20 } as const;
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const IANA_TIME_ZONE = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const ALLOWED_ARGUMENTS = new Set([
  "start",
  "end",
  "minimumSlotMinutes",
  "bufferMinutes",
  "maxResults",
]);

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
  if (!RFC3339_WITH_OFFSET.test(start) || !RFC3339_WITH_OFFSET.test(end)) return null;

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs >= endMs) return null;

  const request: CalendarAvailabilityRequest = { start, end };
  for (const [key, bounds] of [
    ["minimumSlotMinutes", MINIMUM_SLOT_MINUTES],
    ["bufferMinutes", BUFFER_MINUTES],
    ["maxResults", MAX_RESULTS],
  ] as const) {
    const value = args[key];
    if (value === undefined) continue;
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

function sanitizeInterval(value: unknown): CalendarAvailabilityInterval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const interval = value as Record<string, unknown>;
  if (typeof interval.start !== "string" || typeof interval.end !== "string") return null;
  if (!RFC3339_WITH_OFFSET.test(interval.start) || !RFC3339_WITH_OFFSET.test(interval.end)) {
    return null;
  }
  const startMs = Date.parse(interval.start);
  const endMs = Date.parse(interval.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return { start: interval.start, end: interval.end };
}

function isIanaTimeZone(value: string): boolean {
  if (!value || value.length > 128 || !IANA_TIME_ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function sanitizeAvailability(value: unknown): CalendarAvailabilityResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const availability = value as Record<string, unknown>;
  if (!Array.isArray(availability.busy) || !Array.isArray(availability.availableSlots)) return null;
  if (
    typeof availability.hasMore !== "boolean" ||
    typeof availability.isEntireRangeFree !== "boolean"
  ) {
    return null;
  }

  const range = sanitizeInterval(availability.range);
  const timezone = typeof availability.timezone === "string" ? availability.timezone.trim() : "";
  const coverage = availability.coverage;
  if (
    !range ||
    !isIanaTimeZone(timezone) ||
    !coverage ||
    typeof coverage !== "object" ||
    Array.isArray(coverage)
  ) {
    return null;
  }
  const coverageRecord = coverage as Record<string, unknown>;
  if (
    coverageRecord.source !== "local-calendar-cache" ||
    !Number.isSafeInteger(coverageRecord.lookaheadDays) ||
    (coverageRecord.lookaheadDays as number) < 1
  ) {
    return null;
  }

  const busy = availability.busy.map(sanitizeInterval);
  if (busy.some((interval) => interval === null)) return null;

  const availableSlots = availability.availableSlots.map((value) => {
    const interval = sanitizeInterval(value);
    if (!interval || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const durationMinutes = (value as Record<string, unknown>).durationMinutes;
    if (!Number.isSafeInteger(durationMinutes) || (durationMinutes as number) < 1) return null;
    return { ...interval, durationMinutes: durationMinutes as number };
  });
  if (availableSlots.some((slot) => slot === null)) return null;

  return {
    range,
    timezone,
    busy: busy as CalendarAvailabilityInterval[],
    availableSlots: availableSlots as CalendarAvailabilitySlot[],
    hasMore: availability.hasMore,
    isEntireRangeFree: availability.isEntireRangeFree,
    coverage: {
      source: "local-calendar-cache",
      lookaheadDays: coverageRecord.lookaheadDays as number,
    },
  };
}

export const calendarAvailabilityTool: ToolDefinition = {
  name: "get_calendar_availability",
  description:
    "Find open time slots in the local cache for the user's selected connected calendars within the next seven local calendar days. Returns only busy intervals and available slots, never event titles, attendees, or meeting links.",
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
        description:
          "Exclusive range end as an RFC3339 timestamp with Z or an explicit UTC offset. The service limits end plus buffer to seven local calendar days from the current time.",
      },
      minimumSlotMinutes: {
        type: "integer",
        ...MINIMUM_SLOT_MINUTES,
        description: "Minimum duration of a returned free slot in minutes (default 30).",
      },
      bufferMinutes: {
        type: "integer",
        ...BUFFER_MINUTES,
        description: "Minutes to reserve before and after each busy interval (default 0).",
      },
      maxResults: {
        type: "integer",
        ...MAX_RESULTS,
        description: "Maximum number of available slots to return (default 10).",
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
      if (!response?.success) return failure("Failed to fetch calendar availability");

      const availability = sanitizeAvailability(response.availability);
      if (!availability) return failure("Failed to fetch calendar availability");

      const count = availability.availableSlots.length;
      const displayText =
        count === 0
          ? "No available time slots meet the requested minimum duration"
          : availability.isEntireRangeFree
            ? "No scheduled conflicts found in the requested range"
            : `Found ${count} available time slot${count === 1 ? "" : "s"}`;

      return { success: true, data: availability, displayText };
    } catch {
      return failure("Failed to fetch calendar availability");
    }
  },
};
