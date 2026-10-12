import type {
  CalendarRepository,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
} from '@/data/calendarTypes';

export const CALENDAR_EVENT_LOOKBACK_MS = 15 * 60 * 1000;
export const CALENDAR_EVENT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CALENDAR_EVENT_SUGGESTIONS = 6;

const compareEventsByStart = (left: GoogleCalendarEvent, right: GoogleCalendarEvent): number => {
  const start = left.startAt.localeCompare(right.startAt);
  if (start !== 0) return start;
  const end = left.endAt.localeCompare(right.endAt);
  if (end !== 0) return end;
  return (left.summary ?? '').localeCompare(right.summary ?? '');
};

export function getMeetingCalendarEventSuggestions(
  accounts: GoogleCalendarAccount[],
  repo: Pick<CalendarRepository, 'getUpcomingEvents'>,
  now = new Date(),
  limit = MAX_CALENDAR_EVENT_SUGGESTIONS,
): GoogleCalendarEvent[] {
  const fromIso = new Date(now.getTime() - CALENDAR_EVENT_LOOKBACK_MS).toISOString();
  const toIso = new Date(now.getTime() + CALENDAR_EVENT_LOOKAHEAD_MS).toISOString();
  return accounts
    .filter((account) => account.status === 'connected')
    .flatMap((account) => repo.getUpcomingEvents(account.id, fromIso, toIso))
    .sort(compareEventsByStart)
    .slice(0, limit);
}
