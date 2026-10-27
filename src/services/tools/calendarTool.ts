import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { getMeetingJoinUrl } from "../../helpers/meetingJoinUrl";
import { parseEventTime } from "../../helpers/calendarAvailability";
import { localDateFormatter, localizeInstant } from "./calendarAvailabilityTool";

type TimeRange = "today" | "tomorrow" | "week";

// Through the end of the range's last local day ("week": today and the six
// days after it), so all-day and timed events cover the same days.
function getWindowEnd(timeRange: TimeRange): Date {
  const end = new Date();
  end.setDate(end.getDate() + (timeRange === "week" ? 6 : timeRange === "tomorrow" ? 1 : 0));
  end.setHours(23, 59, 59, 999);
  return end;
}

// Rows come straight from the calendar_events table (start_time/end_time
// columns; there is no location column — the join link is what the DB
// actually has for "where"). Dates, weekdays and times are worked out here,
// in the device's time zone: a model that does that math gets weekdays wrong.
// An all-day event is its day(s), never a midnight-to-midnight meeting.
function isAllDay(event: Record<string, unknown>): boolean {
  return event.is_all_day === true || event.is_all_day === 1;
}

function describeEvent(event: Record<string, unknown>, formatter: Intl.DateTimeFormat) {
  const allDay = isAllDay(event);
  const summary = event.summary || "(No title)";
  const joinUrl = getMeetingJoinUrl(event);
  // A holiday, birthday or working location doesn't block the user's time.
  const free = String(event.availability_status ?? "").toLowerCase() === "free";
  const startMs = parseEventTime(event.start_time, allDay);
  const endMs = parseEventTime(event.end_time, allDay);
  if (startMs === null || endMs === null) {
    return {
      summary,
      ...(allDay ? { allDay: true } : {}),
      ...(free ? { free: true } : {}),
      start: event.start_time,
      end: event.end_time,
      joinUrl,
    };
  }
  const start = localizeInstant(startMs, formatter);
  // An all-day event ends where the day after its last one starts.
  const end = localizeInstant(allDay ? endMs - 1 : endMs, formatter);
  const endDate = end.date !== start.date ? { endDate: end.date } : {};
  if (allDay) {
    return {
      summary,
      allDay: true,
      ...(free ? { free: true } : {}),
      date: start.date,
      weekday: start.weekday,
      ...endDate,
      joinUrl,
    };
  }
  return {
    summary,
    start: event.start_time,
    end: event.end_time,
    date: start.date,
    weekday: start.weekday,
    startTime: start.time,
    endTime: end.time,
    ...endDate,
    timeZoneName: start.timeZoneName,
    ...(end.timeZoneName !== start.timeZoneName ? { endTimeZoneName: end.timeZoneName } : {}),
    ...(free ? { free: true } : {}),
    joinUrl,
  };
}

export const calendarTool: ToolDefinition = {
  name: "get_calendar_events",
  description:
    "Get upcoming events from the user's connected calendars for a given time range. Returns each event's summary, local date, weekday, start and end times and time zone, all-day events (allDay) with their dates, and meeting join links. free marks an event that doesn't block the user's time (a holiday, a birthday, a working location).",
  parameters: {
    type: "object",
    properties: {
      timeRange: {
        type: "string",
        enum: ["today", "tomorrow", "week"],
        description: 'Time range to fetch events for (default "today")',
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const timeRange = (args.timeRange as TimeRange) || "today";
    const windowEnd = getWindowEnd(timeRange).getTime();
    // Whole minutes, rounded up past midnight: the query keeps all-day events
    // through the day before the one that ends in.
    const windowMinutes = Math.max(1, Math.ceil((windowEnd - Date.now()) / 60000));

    try {
      const response = await window.electronAPI.gcalGetUpcomingEvents!(windowMinutes, {
        includeAllDay: true,
      });

      if (!response.success) {
        return {
          success: false,
          data: null,
          displayText: "Failed to fetch calendar events",
        };
      }

      const formatter = localDateFormatter(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      // The rounded-up minutes also reach a meeting that starts at the next
      // midnight, which belongs to the day after the range.
      const events = response.events
        .filter(
          (event: Record<string, unknown>) =>
            isAllDay(event) || (parseEventTime(event.start_time, false) ?? 0) <= windowEnd
        )
        .map((event: Record<string, unknown>) => describeEvent(event, formatter));

      if (events.length === 0) {
        return {
          success: true,
          data: [],
          displayText: `No events found for ${timeRange}`,
        };
      }

      return {
        success: true,
        data: events,
        displayText: `Found ${events.length} event${events.length === 1 ? "" : "s"} for ${timeRange}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to fetch calendar events: ${(error as Error).message}`,
      };
    }
  },
};
