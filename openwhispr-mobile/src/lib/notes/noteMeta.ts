import type { CalendarParticipant } from '@/data/calendarTypes';
import { getHumanParticipants } from '@/lib/calendar/meetingContext';
import { formatClockTime } from '@/lib/formatNoteRowTime';
import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';

export const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * When the note was taken. Notes pulled before `created_at` synced were stamped with the pull
 * time, which is later than their last edit on the server, so the earlier of the two is the
 * closer answer. Pass the server's last edit: a local edit would move the date to the pull time.
 */
export function noteTakenAt(
  createdAt: string | null | undefined,
  lastEditedAt: string | null | undefined,
): Date | null {
  const created = tryParseNoteTimestamp(createdAt);
  const lastEdited = tryParseNoteTimestamp(lastEditedAt);
  if (!created || !lastEdited) return created ?? lastEdited;
  return created < lastEdited ? created : lastEdited;
}

/**
 * "Today 09:27", "Yesterday 14:05", "Sep 21, 09:27", or "Sep 21, 2025, 09:27", with the time
 * shown as the notes list shows it.
 */
export function formatNoteMetaDate(timestamp: string | Date | null | undefined, now: Date): string {
  const date = tryParseNoteTimestamp(timestamp);
  if (!date) return '';

  const time = formatClockTime(date);
  if (isSameDay(date, now)) return `Today ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Yesterday ${time}`;

  const day = date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
  return `${day}, ${time}`;
}

/**
 * People who haven't declined, without rooms (flagged, or known by their address or name) or
 * repeats, organizer first, otherwise in calendar order.
 */
export function sortAttendees(participants: CalendarParticipant[]): CalendarParticipant[] {
  const people = getHumanParticipants(participants);
  return [
    ...people.filter((participant) => participant.organizer),
    ...people.filter((participant) => !participant.organizer),
  ];
}

/**
 * `self` comes from the calendar of whoever created the note, so on a teammate's note it marks
 * them. There, you are whoever has your address.
 */
export function markViewer(
  participants: CalendarParticipant[],
  { creatorIsViewer, viewerEmail }: { creatorIsViewer: boolean; viewerEmail: string | null },
): CalendarParticipant[] {
  if (creatorIsViewer) return participants;
  const email = viewerEmail?.toLowerCase();
  return participants.map((participant) => ({
    ...participant,
    self: !!email && participant.email?.toLowerCase() === email,
  }));
}

export function attendeeName(participant: CalendarParticipant): string {
  if (participant.self) return 'You';
  return participant.displayName?.trim() || participant.email || 'Guest';
}

const attendeeFirstName = (participant: CalendarParticipant): string =>
  participant.displayName?.trim().split(/\s+/)[0] || participant.email?.split('@')[0] || 'Guest';

/** "Sam +3": the first attendee who isn't you, plus everyone else. Null when nobody attends. */
export function formatAttendeeChipLabel(participants: CalendarParticipant[]): string | null {
  const people = sortAttendees(participants);
  if (people.length === 0) return null;

  const first = people.find((participant) => !participant.self);
  if (!first) return 'You';

  const others = people.length - 1;
  const name = attendeeFirstName(first);
  return others > 0 ? `${name} +${others}` : name;
}
