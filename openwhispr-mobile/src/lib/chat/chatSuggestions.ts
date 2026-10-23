import type { GoogleCalendarEvent } from '@/data';
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

const calendarSuggestion = (event: GoogleCalendarEvent, now: Date): ChatSuggestion | null => {
  // An all-day event has no start time to prep for.
  if (event.allDay) return null;
  const start = tryParseNoteTimestamp(event.startAt);
  if (!start || !isSameLocalDay(start, now)) return null;
  if (start.getTime() < now.getTime() - RECENTLY_STARTED_MS) return null;

  const summary = event.summary?.trim() || 'Untitled meeting';
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
