import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import {
  findLinkedEvent,
  linkPeople,
  meetingUrlOf,
  parseNoteEventRef,
  personFromEmail,
  suggestPeople,
  unlinkPeople,
  withPeople,
} from '../noteMeta';

const event = (overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent =>
  ({
    id: 1,
    accountId: 1,
    calendarLocalId: 1,
    googleCalendarId: 'primary',
    googleEventId: 'evt-1',
    summary: 'Weekly sync',
    description: null,
    location: null,
    startAt: '2026-11-20T10:00:00.000Z',
    endAt: '2026-11-20T10:30:00.000Z',
    allDay: 0,
    status: 'confirmed',
    organizerEmail: 'sam@x.com',
    attendeesJson: JSON.stringify([
      { email: 'sam@x.com', displayName: 'Sam Kirby' },
      { email: 'priya@x.com', displayName: 'Priya Shah' },
      { email: 'no@x.com', displayName: 'Declined', responseStatus: 'declined' },
      { email: 'room@resource.calendar.google.com', displayName: 'Room', resource: true },
    ]),
    ...overrides,
  }) as GoogleCalendarEvent;

describe('note chip rules', () => {
  it('finds the linked event only from the link the phone writes', () => {
    const ref = parseNoteEventRef(JSON.stringify({ calendarId: 'primary', eventId: 'evt-1' }));
    expect(findLinkedEvent(ref, [event()])?.id).toBe(1);
    expect(findLinkedEvent(ref, [event({ googleCalendarId: 'other' })])).toBeNull();
    expect(parseNoteEventRef('desktop-event-id')).toBeNull();
    expect(parseNoteEventRef('')).toBeNull();
  });

  it('finds a meeting link in the event and ignores other links', () => {
    expect(
      meetingUrlOf(
        event({
          description:
            'Agenda https://docs.example.com/x, join https://meet.google.com/abc-defg-hij.',
        }),
      ),
    ).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetingUrlOf(event({ location: 'https://zoom.us/j/123?pwd=x' }))).toBe(
      'https://zoom.us/j/123?pwd=x',
    );
    expect(meetingUrlOf(event({ description: 'https://example.com/meet' }))).toBeNull();
  });

  it('links the event’s people (no rooms, no one who declined) without duplicating anyone', () => {
    const mine = personFromEmail('PRIYA@x.com', 'Priya');
    const linked = linkPeople([mine], event());
    expect(linked.map((person) => person.email)).toEqual(['priya@x.com', 'sam@x.com']);
  });

  it('unlinks the event’s people and keeps the ones added by hand and yourself', () => {
    const you = { ...personFromEmail('me@x.com'), self: true };
    const added = personFromEmail('new@y.com');
    const people = linkPeople([you, added], event());
    expect(unlinkPeople(people, event()).map((person) => person.email)).toEqual([
      'me@x.com',
      'new@y.com',
    ]);
  });

  it('puts people added by hand first', () => {
    const list = withPeople([personFromEmail('a@x.com')], [personFromEmail('b@x.com')]);
    expect(list.map((person) => person.email)).toEqual(['b@x.com', 'a@x.com']);
  });

  it('suggests by first name or email, skips who is on the note, and offers a typed email', () => {
    const candidates = linkPeople([], event());
    const onNote = [personFromEmail('sam@x.com')];
    expect(suggestPeople('pri', candidates, onNote).people.map((p) => p.email)).toEqual([
      'priya@x.com',
    ]);
    expect(suggestPeople('sam', candidates, onNote).people).toEqual([]);
    expect(suggestPeople('new@y.com', candidates, onNote).typedEmail).toBe('new@y.com');
    expect(suggestPeople('priya@x.com', candidates, onNote).typedEmail).toBeNull();
  });
});
