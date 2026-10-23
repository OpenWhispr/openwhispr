import type { GoogleCalendarEvent } from '@/data';
import { buildChatSuggestions } from '../chatSuggestions';

// Built with local-time constructors so assertions don't depend on the machine's timezone.
const NOW = new Date(2026, 9, 22, 9, 0, 0);

const STATIC_LABELS = [
  'Summarize my meetings this week',
  'What are my open action items from this week?',
  'Who have I promised to follow up with lately?',
  'What did I decide recently?',
];

const makeEvent = (summary: string, start: Date): GoogleCalendarEvent =>
  ({
    id: 1,
    summary,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
  }) as GoogleCalendarEvent;

const time = (date: Date): string =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const labels = (events: GoogleCalendarEvent[]): string[] =>
  buildChatSuggestions({ events, now: NOW }).map((suggestion) => suggestion.label);

describe('buildChatSuggestions', () => {
  it('leads with the next meeting today, then the standing questions', () => {
    const start = new Date(2026, 9, 22, 11, 0);

    const suggestions = buildChatSuggestions({
      events: [makeEvent('Design review', start)],
      now: NOW,
    });

    expect(suggestions[0]).toEqual({
      label: 'Prep me for Design review',
      prompt: `Prep me for "Design review" at ${time(start)}.`,
    });
    expect(suggestions.slice(1).map((suggestion) => suggestion.label)).toEqual(STATIC_LABELS);
    // A standing question is sent as it reads.
    expect(suggestions[1].prompt).toBe(suggestions[1].label);
  });

  it('offers only the standing questions with no meeting today', () => {
    expect(labels([])).toEqual(STATIC_LABELS);
    expect(labels([makeEvent('Tomorrow sync', new Date(2026, 9, 23, 10, 0))])).toEqual(
      STATIC_LABELS,
    );
  });

  it('skips a meeting that started more than 15 minutes ago', () => {
    expect(labels([makeEvent('Standup', new Date(2026, 9, 22, 8, 40))])).toEqual(STATIC_LABELS);
  });

  it('keeps a meeting that started within the last 15 minutes', () => {
    expect(labels([makeEvent('Standup', new Date(2026, 9, 22, 8, 50))])[0]).toBe(
      'Prep me for Standup',
    );
  });

  it('suggests a later meeting when the first has been running a while', () => {
    const allDay = { ...makeEvent('Offsite', new Date(Date.UTC(2026, 9, 22))), allDay: 1 };

    expect(
      labels([
        allDay,
        makeEvent('Standup', new Date(2026, 9, 22, 8, 30)),
        makeEvent('Design review', new Date(2026, 9, 22, 14, 0)),
      ])[0],
    ).toBe('Prep me for Design review');
  });

  it('names an untitled meeting', () => {
    expect(labels([makeEvent('  ', new Date(2026, 9, 22, 11, 0))])[0]).toBe(
      'Prep me for Untitled meeting',
    );
  });
});
