import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { parseEventDate } from "../../utils/dateFormatting";
import { computeAvailability, formatLocalDate, parseTimeOfDay } from "../../utils/availability";

const DAY_MS = 24 * 60 * 60 * 1000;
// The calendar managers sync this far ahead; days past it (and past days,
// which are never synced) have no local data and must not read as "free".
const SYNC_HORIZON_DAYS = 31;
const DEFAULT_DAY_START_MINUTES = 9 * 60;
const DEFAULT_DAY_END_MINUTES = 18 * 60;
const MIN_SLOT_MINUTES = 30;

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && parseEventDate(trimmed) ? trimmed : null;
}

export const availabilityTool: ToolDefinition = {
  name: "get_calendar_availability",
  description:
    "Compute the user's free time slots and busy blocks across all connected calendars for a date range. Use when the user asks when they are free or wants meeting times suggested. Covers today through 31 days ahead; all times are in the user's local timezone.",
  parameters: {
    type: "object",
    properties: {
      start_date: {
        type: "string",
        description:
          'First day to check, as YYYY-MM-DD in the user\'s local timezone (default: today)',
      },
      end_date: {
        type: "string",
        description: "Last day to check, inclusive (default: start_date)",
      },
      day_start: {
        type: "string",
        description: 'Start of the daily availability window, 24h "HH:MM" (default "09:00")',
      },
      day_end: {
        type: "string",
        description: 'End of the daily availability window, 24h "HH:MM" (default "18:00")',
      },
    },
    required: [],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let startDate = parseDateOnly(args.start_date) ?? formatLocalDate(new Date());
    let endDate = parseDateOnly(args.end_date) ?? startDate;
    if (endDate < startDate) [startDate, endDate] = [endDate, startDate];

    const rangeStart = parseEventDate(startDate)!;
    const maxEnd = new Date(
      rangeStart.getFullYear(),
      rangeStart.getMonth(),
      rangeStart.getDate() + SYNC_HORIZON_DAYS - 1
    );
    if (parseEventDate(endDate)! > maxEnd) endDate = formatLocalDate(maxEnd);

    let dayStartMinutes = parseTimeOfDay(args.day_start) ?? DEFAULT_DAY_START_MINUTES;
    let dayEndMinutes = parseTimeOfDay(args.day_end) ?? DEFAULT_DAY_END_MINUTES;
    if (dayEndMinutes <= dayStartMinutes) {
      dayStartMinutes = DEFAULT_DAY_START_MINUTES;
      dayEndMinutes = DEFAULT_DAY_END_MINUTES;
    }

    try {
      // ±1-day pad: all-day rows are stored as bare dates that SQLite compares
      // as UTC midnight, so a tight range could miss one at either edge; the
      // precise per-day filtering happens in computeAvailability.
      const rangeEndExclusive = parseEventDate(endDate)!.getTime() + DAY_MS;
      const response = await window.electronAPI.calendarGetEventsInRange!(
        new Date(rangeStart.getTime() - DAY_MS).toISOString(),
        new Date(rangeEndExclusive + DAY_MS).toISOString()
      );

      if (!response.success) {
        return {
          success: false,
          data: null,
          displayText: "Failed to check calendar availability",
        };
      }

      const computed = computeAvailability(response.events, startDate, endDate, {
        dayStartMinutes,
        dayEndMinutes,
        minSlotMinutes: MIN_SLOT_MINUTES,
      });

      const now = new Date();
      const today = formatLocalDate(now);
      const horizon = formatLocalDate(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + SYNC_HORIZON_DAYS)
      );
      const days = computed.map((day) =>
        day.date < today || day.date > horizon ? { date: day.date, unknown: true } : day
      );

      return {
        success: true,
        data: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, days },
        displayText:
          startDate === endDate
            ? `Checked availability for ${startDate}`
            : `Checked availability for ${startDate} to ${endDate}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to check calendar availability: ${(error as Error).message}`,
      };
    }
  },
};
