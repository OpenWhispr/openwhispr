import type {
  CalendarParticipant,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
} from '@/data/calendarTypes';
import { getHumanParticipants, parseCalendarParticipants } from '@/lib/calendar/meetingContext';

/**
 * The pure rules behind a note's chips (Figma section N): which calendar event a note links to,
 * the meeting link to join, and how linking, unlinking and editing change the note's people.
 */

export type NoteEventRef = { eventId: string; calendarId: string | null };

/** The stored link, as `buildCalendarMeetingContext` writes it. Anything else isn't findable here. */
export function parseNoteEventRef(value: string | null | undefined): NoteEventRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { eventId?: unknown; calendarId?: unknown };
    if (typeof parsed?.eventId !== 'string' || !parsed.eventId) return null;
    return {
      eventId: parsed.eventId,
      calendarId: typeof parsed.calendarId === 'string' ? parsed.calendarId : null,
    };
  } catch {
    return null;
  }
}

export function findLinkedEvent(
  ref: NoteEventRef | null,
  events: GoogleCalendarEvent[],
): GoogleCalendarEvent | null {
  if (!ref) return null;
  return (
    events.find(
      (event) =>
        event.googleEventId === ref.eventId &&
        (ref.calendarId == null || event.googleCalendarId === ref.calendarId),
    ) ?? null
  );
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[),.;:!?]+$/;
const MEETING_HOSTS: { host: string; subdomains?: boolean; path: RegExp }[] = [
  { host: 'zoom.us', subdomains: true, path: /^\/(?:j|w|my)\/[^/]+/i },
  { host: 'meet.google.com', path: /^\/[^/]+/ },
  { host: 'teams.microsoft.com', path: /^\/(?:l\/meetup-join|meet)\/[^/]+/i },
  { host: 'teams.live.com', path: /^\/meet\/[^/]+/i },
  { host: 'webex.com', subdomains: true, path: /^\/[^/]+/ },
  { host: 'chime.aws', path: /^\/[^/]+/ },
];

function isMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return MEETING_HOSTS.some(
      ({ host, subdomains, path }) =>
        (url.hostname === host || (subdomains && url.hostname.endsWith(`.${host}`))) &&
        path.test(url.pathname),
    );
  } catch {
    return false;
  }
}

/** Desktop's `extractMeetingUrl`: the first Zoom, Meet, Teams, Webex or Chime link in the event. */
export function meetingUrlOf(event: GoogleCalendarEvent | null): string | null {
  if (!event) return null;
  for (const text of [event.location, event.description]) {
    if (!text) continue;
    for (const match of text.matchAll(URL_PATTERN)) {
      const value = match[0].replace(TRAILING_PUNCTUATION, '');
      if (isMeetingUrl(value)) return value;
    }
  }
  return null;
}

/** "meet.google.com" under Join meeting. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const keyOf = (person: Pick<CalendarParticipant, 'email' | 'displayName'>): string | null =>
  person.email?.trim().toLowerCase() || person.displayName?.trim().toLowerCase() || null;

/** The event's guests a note takes: no rooms, nobody who declined, the organizer included. */
export function eventPeople(event: GoogleCalendarEvent): CalendarParticipant[] {
  const guests = parseCalendarParticipants(event.attendeesJson) ?? [];
  const organizer = event.organizerEmail?.trim().toLowerCase();
  const withOrganizer =
    organizer && !guests.some((person) => person.email === organizer)
      ? [
          ...guests,
          {
            email: organizer,
            displayName: null,
            responseStatus: 'accepted' as const,
            optional: false,
            organizer: true,
            resource: false,
            self: false,
          },
        ]
      : guests;
  return getHumanParticipants(withOrganizer);
}

/** Linking adds the event's people the note doesn't have, and leaves everyone already there. */
export function linkPeople(
  current: CalendarParticipant[],
  event: GoogleCalendarEvent,
): CalendarParticipant[] {
  const have = new Set(current.map(keyOf).filter(Boolean));
  return [...current, ...eventPeople(event).filter((person) => !have.has(keyOf(person)))];
}

/** Unlinking drops the people the event added and keeps the ones you added (and yourself). */
export function unlinkPeople(
  current: CalendarParticipant[],
  event: GoogleCalendarEvent | null,
): CalendarParticipant[] {
  if (!event) return current;
  const fromEvent = new Set(eventPeople(event).map(keyOf).filter(Boolean));
  return current.filter((person) => person.self || !fromEvent.has(keyOf(person)));
}

export function withoutPerson(
  current: CalendarParticipant[],
  person: CalendarParticipant,
): CalendarParticipant[] {
  const key = keyOf(person);
  return current.filter((other) => keyOf(other) !== key);
}

/** People added by hand go first, so the new rows sit at the top of People. */
export function withPeople(
  current: CalendarParticipant[],
  added: CalendarParticipant[],
): CalendarParticipant[] {
  const have = new Set(current.map(keyOf).filter(Boolean));
  const fresh = added.filter((person) => {
    const key = keyOf(person);
    if (!key || have.has(key)) return false;
    have.add(key);
    return true;
  });
  return [...fresh, ...current];
}

export function personFromEmail(email: string, displayName?: string | null): CalendarParticipant {
  return {
    email: email.trim().toLowerCase(),
    displayName: displayName?.trim() || null,
    responseStatus: null,
    optional: false,
    organizer: false,
    resource: false,
    self: false,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (value: string): boolean => EMAIL.test(value.trim());

/**
 * N6's suggestions: people from calendar events and other notes who aren't on this note, matching
 * the typed name or email; a typed full email nobody has comes first as "Add priya@…".
 */
export function suggestPeople(
  query: string,
  candidates: CalendarParticipant[],
  onNote: CalendarParticipant[],
  limit = 6,
): { typedEmail: string | null; people: CalendarParticipant[] } {
  const needle = query.trim().toLowerCase();
  const taken = new Set(onNote.map(keyOf).filter(Boolean));
  const seen = new Set<string>();
  const people: CalendarParticipant[] = [];
  for (const person of candidates) {
    if (person.self || person.resource || !person.email) continue;
    const key = keyOf(person);
    if (!key || taken.has(key) || seen.has(key)) continue;
    const name = person.displayName?.toLowerCase() ?? '';
    if (
      needle &&
      !person.email.includes(needle) &&
      !name.split(/\s+/).some((word) => word.startsWith(needle)) &&
      !name.startsWith(needle)
    )
      continue;
    seen.add(key);
    people.push(person);
  }
  // A known name sorts ahead of a bare address.
  people.sort((left, right) => Number(!left.displayName) - Number(!right.displayName));
  const typedEmail =
    isEmail(needle) && !taken.has(needle) && !people.some((person) => person.email === needle)
      ? needle
      : null;
  return { typedEmail, people: people.slice(0, needle ? limit : Math.min(limit, 4)) };
}

export type EventDay = { key: string; date: Date; events: GoogleCalendarEvent[] };

/** Events grouped by local day, each day's in time order. */
export function groupByDay(events: GoogleCalendarEvent[]): EventDay[] {
  const days = new Map<string, EventDay>();
  for (const event of [...events].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    const date = new Date(event.startAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const day = days.get(key) ?? {
      key,
      date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
      events: [],
    };
    day.events.push(event);
    days.set(key, day);
  }
  return [...days.values()];
}

export function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function accountFor(
  event: GoogleCalendarEvent,
  accounts: GoogleCalendarAccount[],
): GoogleCalendarAccount | null {
  return accounts.find((account) => account.id === event.accountId) ?? null;
}
