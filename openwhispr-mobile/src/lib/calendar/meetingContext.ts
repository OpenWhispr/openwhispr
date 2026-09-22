import type {
  CalendarParticipant,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
} from '@/data/calendarTypes';
import { DEFAULT_MEETING_TITLE } from '@/lib/notes/meetingConstants';

export type CalendarMeetingContext = {
  calendarEventId: string;
  title: string;
  participants: CalendarParticipant[];
  suggestedSpeakerCount?: number;
};

export type CalendarSpeakerLabelSuggestion = {
  label: string;
  email: string | null;
};

const normalizeText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const normalizeEmail = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

const coerceParticipant = (value: unknown): CalendarParticipant | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<CalendarParticipant>;
  const email = normalizeEmail(item.email);
  const displayName = normalizeText(item.displayName);
  if (!email && !displayName) return null;
  const responseStatus =
    item.responseStatus === 'accepted' ||
    item.responseStatus === 'declined' ||
    item.responseStatus === 'tentative' ||
    item.responseStatus === 'needsAction'
      ? item.responseStatus
      : null;

  return {
    email,
    displayName,
    responseStatus,
    optional: !!item.optional,
    organizer: !!item.organizer,
    resource: !!item.resource,
    self: !!item.self,
  };
};

export function parseCalendarParticipants(value: string | null): CalendarParticipant[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(coerceParticipant)
      .filter((participant): participant is CalendarParticipant => participant !== null);
  } catch {
    return null;
  }
}

const dedupeParticipants = (participants: CalendarParticipant[]): CalendarParticipant[] => {
  const deduped = new Map<string, CalendarParticipant>();
  for (const participant of participants) {
    const key = participant.email ?? participant.displayName?.trim().toLowerCase();
    if (!key || deduped.has(key)) continue;
    deduped.set(key, participant);
  }
  return [...deduped.values()];
};

const withOrganizer = (
  event: GoogleCalendarEvent,
  participants: CalendarParticipant[],
): CalendarParticipant[] => {
  const organizerEmail = normalizeEmail(event.organizerEmail);
  if (!organizerEmail) return dedupeParticipants(participants);
  const hasOrganizer = participants.some((participant) => participant.email === organizerEmail);
  if (hasOrganizer) return dedupeParticipants(participants);
  return dedupeParticipants([
    ...participants,
    {
      email: organizerEmail,
      displayName: null,
      responseStatus: 'accepted',
      optional: false,
      organizer: true,
      resource: false,
      self: false,
    },
  ]);
};

const isRoomLikeParticipant = (participant: CalendarParticipant): boolean => {
  if (participant.resource) return true;
  const email = participant.email ?? '';
  const displayName = participant.displayName?.trim().toLowerCase() ?? '';
  if (email.endsWith('@resource.calendar.google.com')) return true;
  return /\b(boardroom|conference room|huddle room|meeting room|room)\b/.test(displayName);
};

const getHumanParticipants = (participants: CalendarParticipant[]): CalendarParticipant[] =>
  dedupeParticipants(
    participants.filter(
      (participant) =>
        participant.responseStatus !== 'declined' && !isRoomLikeParticipant(participant),
    ),
  );

export function getCalendarParticipantEmails(participants: CalendarParticipant[]): string[] {
  return getHumanParticipants(participants)
    .map((participant) => participant.email)
    .filter((email): email is string => !!email);
}

export function getCalendarSpeakerLabelSuggestions(
  participants: CalendarParticipant[],
): CalendarSpeakerLabelSuggestion[] {
  return getHumanParticipants(participants)
    .map((participant) => {
      const label = normalizeText(participant.displayName) ?? participant.email;
      return label ? { label, email: participant.email } : null;
    })
    .filter((suggestion): suggestion is CalendarSpeakerLabelSuggestion => suggestion !== null);
}

export function getSpeakerCountSuggestion(participants: CalendarParticipant[]): number | undefined {
  const humans = getHumanParticipants(participants);
  return humans.length > 0 ? humans.length : undefined;
}

export function buildCalendarMeetingContext(
  event: GoogleCalendarEvent,
  account: GoogleCalendarAccount | null | undefined,
): CalendarMeetingContext {
  const participants = withOrganizer(event, parseCalendarParticipants(event.attendeesJson) ?? []);
  const eventTitle = normalizeText(event.summary) ?? DEFAULT_MEETING_TITLE;
  return {
    calendarEventId: JSON.stringify({
      provider: 'google_calendar',
      accountSubject: account?.googleSubject ?? null,
      calendarId: event.googleCalendarId,
      eventId: event.googleEventId,
      iCalUID: event.iCalUID ?? null,
    }),
    title: eventTitle,
    participants,
    suggestedSpeakerCount: getSpeakerCountSuggestion(participants),
  };
}
