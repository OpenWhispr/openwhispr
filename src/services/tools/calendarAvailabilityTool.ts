import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { USER_CORRECTABLE_ERRORS } from "../../helpers/calendarAvailability";
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
    !Array.isArray(payload.busy) ||
    !Array.isArray(payload.availableSlots) ||
    !Number.isSafeInteger(lookaheadDays) ||
    (lookaheadDays as number) < 1
  ) {
    return null;
  }

  const busy: CalendarAvailabilityInterval[] = [];
  for (const item of payload.busy) {
    const interval = toInterval(item);
    if (!interval) return null;
    busy.push(interval);
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
    busy,
    availableSlots,
    hasMore: payload.hasMore,
    isEntireRangeFree: payload.isEntireRangeFree,
    coverage: { source: "local-calendar-cache", lookaheadDays: lookaheadDays as number },
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

      return { success: true, data: availability, displayText };
    } catch {
      return failure("Failed to fetch calendar availability");
    }
  },
};
