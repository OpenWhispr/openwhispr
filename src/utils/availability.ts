import { parseEventDate } from "./dateFormatting";
import type { CalendarAttendee, CalendarEvent } from "../types/calendar";

export interface AvailabilitySlot {
  start: string;
  end: string;
}

export interface AvailabilityBusyBlock extends AvailabilitySlot {
  summary: string;
  status: string;
}

export interface AvailabilityDay {
  date: string;
  free: AvailabilitySlot[];
  busy: AvailabilityBusyBlock[];
  allDayEvents: Array<{ summary: string; status: string }>;
}

export interface AvailabilityOptions {
  dayStartMinutes: number;
  dayEndMinutes: number;
  minSlotMinutes: number;
}

const MINUTE_MS = 60000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Local wall-clock form (YYYY-MM-DDTHH:MM): the model presents these to the
// user directly, so they must already be in the user's timezone.
function formatLocal(date: Date): string {
  return `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// A meeting the user declined no longer holds their time.
function isDeclinedByUser(event: CalendarEvent): boolean {
  if (!event.attendees) return false;
  try {
    const attendees = JSON.parse(event.attendees) as CalendarAttendee[];
    return attendees.some((a) => a.self && a.responseStatus === "declined");
  } catch {
    return false;
  }
}

// All-day events (OOO, PTO, birthdays) are reported per day but never
// subtracted from free time: without the providers' free/busy field there is
// no way to tell a blocking OOO from a transparent birthday, so the model
// surfaces them as caveats instead.
export function computeAvailability(
  events: CalendarEvent[],
  startDate: string,
  endDate: string,
  { dayStartMinutes, dayEndMinutes, minSlotMinutes }: AvailabilityOptions
): AvailabilityDay[] {
  const timed: Array<{ event: CalendarEvent; start: Date; end: Date }> = [];
  const allDay: typeof timed = [];
  for (const event of events) {
    if (isDeclinedByUser(event)) continue;
    const start = parseEventDate(event.start_time);
    const end = parseEventDate(event.end_time);
    if (!start || !end) continue;
    (event.is_all_day ? allDay : timed).push({ event, start, end });
  }

  const rangeStart = parseEventDate(startDate);
  const rangeEnd = parseEventDate(endDate);
  const days: AvailabilityDay[] = [];
  if (!rangeStart || !rangeEnd) return days;

  for (
    let day = rangeStart;
    day <= rangeEnd;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const windowStart = new Date(day.getTime() + dayStartMinutes * MINUTE_MS);
    const windowEnd = new Date(day.getTime() + dayEndMinutes * MINUTE_MS);

    const intervals = timed
      .filter(({ start, end }) => start < windowEnd && end > windowStart)
      .map(({ event, start, end }) => ({
        start: start < windowStart ? windowStart : start,
        end: end > windowEnd ? windowEnd : end,
        summary: event.summary || "(No title)",
        status: event.status,
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const free: AvailabilitySlot[] = [];
    let cursor = windowStart;
    for (const interval of intervals) {
      if (interval.start.getTime() - cursor.getTime() >= minSlotMinutes * MINUTE_MS) {
        free.push({ start: formatLocal(cursor), end: formatLocal(interval.start) });
      }
      if (interval.end > cursor) cursor = interval.end;
    }
    if (windowEnd.getTime() - cursor.getTime() >= minSlotMinutes * MINUTE_MS) {
      free.push({ start: formatLocal(cursor), end: formatLocal(windowEnd) });
    }

    days.push({
      date: formatLocalDate(day),
      free,
      busy: intervals.map((i) => ({
        start: formatLocal(i.start),
        end: formatLocal(i.end),
        summary: i.summary,
        status: i.status,
      })),
      allDayEvents: allDay
        .filter(({ start, end }) => start < nextDay && end > day)
        .map(({ event }) => ({ summary: event.summary || "(No title)", status: event.status })),
    });
  }

  return days;
}
