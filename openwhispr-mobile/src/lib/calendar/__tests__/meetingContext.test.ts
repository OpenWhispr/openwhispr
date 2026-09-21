import type {
  CalendarParticipant,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
} from '@/data/calendarTypes';
import {
  buildCalendarMeetingContext,
  getCalendarParticipantEmails,
  getCalendarSpeakerLabelSuggestions,
  getSpeakerCountSuggestion,
  parseCalendarParticipants,
} from '../meetingContext';

const participant = (overrides: Partial<CalendarParticipant>): CalendarParticipant => ({
  email: null,
  displayName: null,
  responseStatus: 'accepted',
  optional: false,
  organizer: false,
  resource: false,
  self: false,
  ...overrides,
});

const event = (overrides: Partial<GoogleCalendarEvent>): GoogleCalendarEvent =>
  ({
    id: 30,
    accountId: 1,
    calendarLocalId: 10,
    googleCalendarId: 'primary',
    googleEventId: 'event-1',
    iCalUID: 'ical-1',
    summary: 'Weekly Planning',
    description: null,
    location: null,
    startAt: '2026-06-24T10:00:00.000Z',
    endAt: '2026-06-24T11:00:00.000Z',
    allDay: 0,
    status: 'confirmed',
    organizerEmail: 'organizer@example.com',
    creatorEmail: null,
    attendeesJson: null,
    updated: null,
    htmlLink: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarEvent;

const account = (overrides: Partial<GoogleCalendarAccount> = {}): GoogleCalendarAccount =>
  ({
    id: 1,
    googleSubject: 'google-sub-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    grantedScopes: 'openid email calendar',
    status: 'connected',
    lastSyncAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarAccount;

describe('calendar meeting context', () => {
  it('parses normalized attendee JSON defensively', () => {
    expect(parseCalendarParticipants(null)).toBeNull();
    expect(parseCalendarParticipants('not-json')).toBeNull();
    expect(
      parseCalendarParticipants(JSON.stringify([{ email: ' Alice@Example.com ' }, {}])),
    ).toEqual([expect.objectContaining({ email: 'alice@example.com', displayName: null })]);
  });

  it('suggests speaker count from non-declined human attendees only', () => {
    expect(
      getSpeakerCountSuggestion([
        participant({ email: 'alice@example.com' }),
        participant({ email: 'alice@example.com', displayName: 'Duplicate Alice' }),
        participant({ email: 'bob@example.com', responseStatus: 'declined' }),
        participant({ displayName: 'Conference Room', resource: true }),
        participant({ displayName: 'Huddle Room' }),
        participant({ displayName: 'Casey' }),
      ]),
    ).toBe(2);
  });

  it('returns human attendee emails and quick-label suggestions', () => {
    const participants = [
      participant({ email: 'alice@example.com', displayName: 'Alice' }),
      participant({ email: 'alice@example.com', displayName: 'Duplicate Alice' }),
      participant({ email: 'bob@example.com', responseStatus: 'declined' }),
      participant({ displayName: 'Conference Room', resource: true }),
      participant({ email: 'casey@example.com' }),
    ];

    expect(getCalendarParticipantEmails(participants)).toEqual([
      'alice@example.com',
      'casey@example.com',
    ]);
    expect(getCalendarSpeakerLabelSuggestions(participants)).toEqual([
      { label: 'Alice', email: 'alice@example.com' },
      { label: 'casey@example.com', email: 'casey@example.com' },
    ]);
  });

  it('builds selected event context with organizer fallback and opaque event id', () => {
    const context = buildCalendarMeetingContext(
      event({
        attendeesJson: JSON.stringify([participant({ email: 'attendee@example.com' })]),
      }),
      account(),
    );

    expect(context.title).toBe('Weekly Planning');
    expect(context.participants).toEqual([
      expect.objectContaining({ email: 'attendee@example.com' }),
      expect.objectContaining({ email: 'organizer@example.com', organizer: true }),
    ]);
    expect(context.suggestedSpeakerCount).toBe(2);
    expect(JSON.parse(context.calendarEventId)).toEqual({
      provider: 'google_calendar',
      accountSubject: 'google-sub-1',
      calendarId: 'primary',
      eventId: 'event-1',
      iCalUID: 'ical-1',
    });
  });

  it('uses the default meeting title when an event summary is unavailable', () => {
    const context = buildCalendarMeetingContext(
      event({ summary: '   ', organizerEmail: null }),
      null,
    );

    expect(context.title).toBe('Untitled meeting');
    expect(context.participants).toEqual([]);
    expect(context.suggestedSpeakerCount).toBeUndefined();
  });
});
