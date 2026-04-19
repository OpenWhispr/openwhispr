import type { ToolDefinition, ToolResult } from "./ToolRegistry";

type TimeRange = "today" | "tomorrow" | "week";

function getWindowMinutes(timeRange: TimeRange): number {
  if (timeRange === "week") return 10080;

  const now = new Date();
  if (timeRange === "tomorrow") {
    const endOfTomorrow = new Date(now);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setHours(23, 59, 59, 999);
    return Math.ceil((endOfTomorrow.getTime() - now.getTime()) / 60000);
  }

  // "today": remaining minutes until midnight
  const midnight = new Date(now);
  midnight.setHours(23, 59, 59, 999);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 60000));
}

export const calendarTool: ToolDefinition = {
  name: "get_calendar_events",
  description:
    "Get upcoming Google Calendar events for a given time range. Returns event summaries, times, and locations.",
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
    const windowMinutes = getWindowMinutes(timeRange);

    try {
      const response = await window.electronAPI.gcalGetUpcomingEvents!(windowMinutes);

      if (!response.success) {
        return {
          success: false,
          data: null,
          displayText: "Failed to fetch calendar events",
        };
      }

      const events = response.events.map((event: Record<string, unknown>) => ({
        summary: event.summary || "(No title)",
        start: event.start,
        end: event.end,
        location: event.location || null,
      }));

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
