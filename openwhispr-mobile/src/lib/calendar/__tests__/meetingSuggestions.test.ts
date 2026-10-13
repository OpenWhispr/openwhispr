import type {
  CalendarRepository,
  GoogleCalendarAccount,
  GoogleCalendarEvent,
} from '@/data/calendarTypes';
import { getMeetingCalendarEventSuggestions } from '../meetingSuggestions';

const account = (overrides: Partial<GoogleCalendarAccount>): GoogleCalendarAccount =>
  ({
    id: 1,
    googleSubject: `google-sub-${overrides.id ?? 1}`,
    email: null,
    displayName: null,
    grantedScopes: null,
    status: 'connected',
    lastSyncAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarAccount;

const event = (overrides: Partial<GoogleCalendarEvent>): GoogleCalendarEvent =>
  ({
    id: 1,
    accountId: 1,
    calendarLocalId: 10,
    googleCalendarId: 'primary',
    googleEventId: `event-${overrides.id ?? 1}`,
    iCalUID: null,
    summary: null,
    description: null,
    location: null,
    startAt: '2026-06-24T10:00:00.000Z',
    endAt: '2026-06-24T11:00:00.000Z',
    allDay: 0,
    status: 'confirmed',
    organizerEmail: null,
    creatorEmail: null,
    attendeesJson: null,
    updated: null,
    htmlLink: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as GoogleCalendarEvent;

describe('getMeetingCalendarEventSuggestions', () => {
  it('sorts merged multi-account events before truncating', () => {
    const eventsByAccountId: Record<number, GoogleCalendarEvent[]> = {
      1: [
        event({
          id: 101,
          accountId: 1,
          summary: 'Later account one',
          startAt: '2026-06-24T15:00:00.000Z',
        }),
        event({
          id: 102,
          accountId: 1,
          summary: 'Second soonest',
          startAt: '2026-06-24T11:00:00.000Z',
        }),
      ],
      2: [
        event({
          id: 201,
          accountId: 2,
          summary: 'Soonest account two',
          startAt: '2026-06-24T09:00:00.000Z',
        }),
      ],
    };
    const repo = {
      getUpcomingEvents: jest.fn((accountId: number) => eventsByAccountId[accountId] ?? []),
    } as Pick<CalendarRepository, 'getUpcomingEvents'>;

    const suggestions = getMeetingCalendarEventSuggestions(
      [account({ id: 1 }), account({ id: 2 })],
      repo,
      new Date('2026-06-24T08:30:00.000Z'),
      2,
    );

    expect(suggestions.map((item) => item.id)).toEqual([201, 102]);
  });

  it('ignores disconnected accounts', () => {
    const repo = {
      getUpcomingEvents: jest.fn(() => [event({ id: 101 })]),
    } as Pick<CalendarRepository, 'getUpcomingEvents'>;

    expect(
      getMeetingCalendarEventSuggestions([account({ status: 'needs_reconnect' })], repo),
    ).toEqual([]);
    expect(repo.getUpcomingEvents).not.toHaveBeenCalled();
  });
});
