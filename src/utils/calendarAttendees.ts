import type { CalendarAttendee, CalendarEvent } from "../types/calendar";
import { parseNoteParticipants } from "./noteAttendees";
import {
  meetingAttendeeVerdict,
  readCalendarRoster,
  unlistedOrganizerEmail,
} from "../helpers/meetingAttendeePolicy.js";

export function hasExternalAttendees(
  event: CalendarEvent,
  internalDomains: readonly string[]
): boolean {
  return (
    meetingAttendeeVerdict(event, { externalAttendees: "blocked", internalDomains }) === "external"
  );
}

export function parseAttendees(event: CalendarEvent): CalendarAttendee[] {
  return parseNoteParticipants(event.attendees);
}

/**
 * True when someone other than the current user is on the invite. The user is
 * on every event they can see, so a solo time block or a self-only event is
 * not a meeting and stays out of the upcoming list.
 */
export function hasOtherAttendees(event: CalendarEvent): boolean {
  if (event.attendees_omitted) return true;
  const attendees = (readCalendarRoster(event.attendees) ?? []).filter(
    (attendee) => attendee && typeof attendee === "object"
  );
  return (
    attendees.some((attendee) => !attendee.self) ||
    event.attendees_count > Math.max(1, attendees.length) ||
    (!event.organizer_self &&
      attendees.length > 0 &&
      Boolean(unlistedOrganizerEmail(event, attendees)))
  );
}
