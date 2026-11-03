import { CALENDAR_LOOKBACK_MS } from "../helpers/calendarCacheWindow";
import type { CalendarEvent } from "../types/calendar";
import { parseAttendees } from "./calendarAttendees";
import { parseEventDate } from "./dateFormatting";

const MAX_SEARCH_RESULTS = 50;

function startOfLocalDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function nextLocalMidnight(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}

/** Events that overlap the note's local calendar day: all-day ones first, then in their given order. */
export function eventsOnDay<T extends CalendarEvent>(events: T[], day: Date): T[] {
  const dayStart = startOfLocalDay(day).getTime();
  const dayEnd = nextLocalMidnight(day).getTime();
  return events
    .filter((event) => {
      const start = parseEventDate(event.start_time)?.getTime();
      const end = parseEventDate(event.end_time)?.getTime();
      if (start === undefined || end === undefined) return false;
      return start < dayEnd && Math.max(end, start + 1) > dayStart;
    })
    .sort((a, b) => Number(Boolean(b.is_all_day)) - Number(Boolean(a.is_all_day)));
}

/** Title or guest matches across every stored event, nearest to the note first. */
export function searchLinkableEvents<T extends CalendarEvent>(
  events: T[],
  query: string,
  anchor: Date,
  limit = MAX_SEARCH_RESULTS
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const anchorMs = anchor.getTime();
  const distance = (event: T) =>
    Math.abs((parseEventDate(event.start_time)?.getTime() ?? Infinity) - anchorMs);
  return events
    .filter(
      (event) =>
        (event.summary ?? "").toLowerCase().includes(needle) ||
        parseAttendees(event).some(
          (guest) =>
            (guest.displayName ?? "").toLowerCase().includes(needle) ||
            (guest.email ?? "").toLowerCase().includes(needle)
        )
    )
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, limit);
}

/** True when the local day starts before the stored history, so some or all of its events aren't stored. */
export function startsBeforeStoredWindow(day: Date, now = Date.now()): boolean {
  return startOfLocalDay(day).getTime() < now - CALENDAR_LOOKBACK_MS;
}
