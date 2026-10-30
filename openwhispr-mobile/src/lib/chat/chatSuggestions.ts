import type { GoogleCalendarEvent } from '@/data';
import {
  isDeclinedByUser,
  isRoomLikeParticipant,
  parseCalendarParticipants,
} from '@/lib/calendar/meetingContext';
import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';
import { formatChatTime, isSameLocalDay } from './chatContext';

export interface ChatSuggestion {
  label: string;
  /** What's sent, which can say more than the label has room for. */
  prompt: string;
}

export interface ChatSuggestionsInput {
  /** Upcoming events by start time; the first one worth prepping for is suggested. */
  events: GoogleCalendarEvent[];
  now: Date;
}

const RECENTLY_STARTED_MS = 15 * 60 * 1000;

// Each names a period, so it reads that period's notes even when none use its words ("action
// items", "follow up"). "Lately" and "recently" are the last 7 days, which still hold notes early
// in a week.
const STATIC_SUGGESTIONS: readonly ChatSuggestion[] = [
  'Summarize my meetings this week',
  'What are my open action items from this week?',
  'Who have I promised to follow up with lately?',
  'What did I decide recently?',
].map((question) => ({ label: question, prompt: question }));

const TITLE_MAX_LENGTH = 80;

// A block on the user's own calendar ("Lunch", "Focus time") invites nobody else, so there is
// nobody to prep for. A guest who declined still makes it a meeting.
const hasOtherPeople = (event: GoogleCalendarEvent): boolean =>
  (parseCalendarParticipants(event.attendeesJson) ?? []).some(
    (participant) => !participant.self && !isRoomLikeParticipant(participant),
  );

// The invite's title, written by whoever sent it, becomes part of the user's own question, so it
// is kept to one short line with no quotes of its own to close the one around it.
const toPromptTitle = (summary: string): string =>
  summary
    .replace(/["“”\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_LENGTH)
    .trim();

const calendarSuggestion = (event: GoogleCalendarEvent, now: Date): ChatSuggestion | null => {
  // An all-day event has no start time to prep for.
  if (event.allDay) return null;
  const start = tryParseNoteTimestamp(event.startAt);
  if (!start || !isSameLocalDay(start, now)) return null;
  if (start.getTime() < now.getTime() - RECENTLY_STARTED_MS) return null;
  // The upcoming list keeps a meeting until 15 minutes after it ends, and a short one can be over
  // before its start leaves the window.
  const end = tryParseNoteTimestamp(event.endAt);
  if (end && end.getTime() <= now.getTime()) return null;
  if (isDeclinedByUser(event) || !hasOtherPeople(event)) return null;

  const summary = toPromptTitle(event.summary ?? '') || 'Untitled meeting';
  return {
    label: `Prep me for ${summary}`,
    prompt: `Prep me for "${summary}" at ${formatChatTime(start)}.`,
  };
};

export const buildChatSuggestions = ({ events, now }: ChatSuggestionsInput): ChatSuggestion[] => {
  // A meeting still running, or an all-day event, mustn't hide a later meeting today.
  for (const event of events) {
    const calendar = calendarSuggestion(event, now);
    if (calendar) return [calendar, ...STATIC_SUGGESTIONS];
  }
  return [...STATIC_SUGGESTIONS];
};
