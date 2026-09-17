import type { CalendarAttendee, CalendarEvent } from "../types/calendar";

export function parseAttendees(event: CalendarEvent): CalendarAttendee[] {
  if (!event.attendees) return [];
  try {
    const parsed = JSON.parse(event.attendees);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * True when someone other than the current user is on the invite. The user is
 * on every event they can see, so a solo time block or a self-only event is
 * not a meeting and stays out of the upcoming list.
 */
export function hasOtherAttendees(event: CalendarEvent): boolean {
  const attendees = parseAttendees(event);
  if (attendees.length > 0) return attendees.some((attendee) => !attendee.self);
  return event.attendees_count > 1;
}
