import { eq } from 'drizzle-orm';
import { googleCalendarEvents } from '@/db/schema';
import { LocalCalendarRepository } from '@/data/local/calendarRepository';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { GoogleCalendarApiError } from '../googleCalendarApi';

jest.mock('@/lib/sentry', () => ({
  Sentry: {
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
  },
}));

import {
  normalizeCalendarEvent,
  normalizeCalendarParticipants,
  syncGoogleCalendarList,
  syncSelectedGoogleCalendarEventWindow,
} from '../googleCalendarSync';

const createCalendarRepo = () => {
  const { db } = createMemoryRepository();
  return {
    db,
    repo: new LocalCalendarRepository(
      db as unknown as ConstructorParameters<typeof LocalCalendarRepository>[0],
    ),
  };
};

describe('googleCalendarSync', () => {
  it('normalizes and dedupes attendees while adding organizer context', () => {
    expect(
      normalizeCalendarParticipants({
        organizer: { email: 'Owner@Example.com', displayName: 'Owner' },
        attendees: [
          { email: 'Alice@Example.com', displayName: 'Alice', responseStatus: 'accepted' },
          {
            email: 'alice@example.com',
            displayName: 'Alice Duplicate',
            responseStatus: 'declined',
          },
          { email: 'room@example.com', displayName: 'Room', resource: true },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        email: 'alice@example.com',
        displayName: 'Alice Duplicate',
        responseStatus: 'declined',
      }),
      expect.objectContaining({ email: 'room@example.com', resource: true }),
      expect.objectContaining({ email: 'owner@example.com', organizer: true }),
    ]);
  });

  it('normalizes private, all-day, and cancelled events safely', () => {
    expect(
      normalizeCalendarEvent(
        {
          id: 'private',
          visibility: 'private',
          start: { date: '2026-06-23' },
          end: { date: '2026-06-24' },
        },
        'primary',
      ),
    ).toEqual(
      expect.objectContaining({
        googleEventId: 'private',
        summary: 'Busy',
        startAt: '2026-06-23T00:00:00.000Z',
        endAt: '2026-06-24T00:00:00.000Z',
        allDay: true,
      }),
    );
    expect(normalizeCalendarEvent({ id: 'cancelled', status: 'cancelled' }, 'primary')).toBeNull();
  });

  it('full CalendarList sync stores token and marks absent calendars deleted', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'old', summary: 'Old', selected: true },
      { googleCalendarId: 'primary', summary: 'Stale Primary', selected: true },
    ]);
    const old = repo.getCalendarByGoogleId(account.id, 'old')!;
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: old.id,
      googleCalendarId: 'old',
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: 'old',
          googleEventId: 'old-event',
          startAt: '2026-06-24T10:00:00.000Z',
          endAt: '2026-06-24T11:00:00.000Z',
        },
      ],
    });
    const fetchCalendarListPage = jest.fn().mockResolvedValue({
      items: [
        { id: 'primary', summary: 'Primary', primary: true },
        { id: 'team', summary: 'Team' },
      ],
      nextSyncToken: 'sync-token-1',
    });

    await syncGoogleCalendarList(account.id, {
      repo,
      getAccessToken: async () => 'access-token',
      fetchCalendarListPage,
      now: () => new Date('2026-06-23T12:00:00.000Z'),
    });

    expect(fetchCalendarListPage).toHaveBeenCalledWith('access-token', {
      pageToken: null,
      syncToken: null,
    });
    expect(repo.getCalendarListSyncToken(account.id)).toBe('sync-token-1');
    expect(repo.getCalendarByGoogleId(account.id, 'primary')).toEqual(
      expect.objectContaining({ summary: 'Primary', selected: 1 }),
    );
    expect(repo.getCalendarByGoogleId(account.id, 'old')).toEqual(
      expect.objectContaining({ selected: 0 }),
    );
    expect(
      repo.getUpcomingEvents(account.id, '2026-06-23T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
    ).toEqual([]);
  });

  it('incremental CalendarList sync deletes only entries marked deleted', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'keep', summary: 'Keep', selected: true },
      { googleCalendarId: 'delete', summary: 'Delete', selected: true },
    ]);
    repo.setCalendarListSyncToken(account.id, 'old-sync-token');

    await syncGoogleCalendarList(account.id, {
      repo,
      getAccessToken: async () => 'access-token',
      fetchCalendarListPage: jest.fn().mockResolvedValue({
        items: [
          { id: 'keep', summary: 'Keep Renamed' },
          { id: 'delete', deleted: true },
        ],
        nextSyncToken: 'new-sync-token',
      }),
    });

    expect(repo.getCalendarByGoogleId(account.id, 'keep')).toEqual(
      expect.objectContaining({ summary: 'Keep Renamed', selected: 1 }),
    );
    expect(repo.getCalendarByGoogleId(account.id, 'delete')).toEqual(
      expect.objectContaining({ selected: 0 }),
    );
    expect(repo.getCalendarListSyncToken(account.id)).toBe('new-sync-token');
  });

  it('clears calendar cache and retries full CalendarList sync on 410', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'stale', summary: 'Stale' }]);
    repo.setCalendarListSyncToken(account.id, 'expired-sync-token');
    const fetchCalendarListPage = jest
      .fn()
      .mockRejectedValueOnce(new GoogleCalendarApiError('Sync token expired', 410))
      .mockResolvedValueOnce({
        items: [{ id: 'primary', summary: 'Primary', primary: true }],
        nextSyncToken: 'fresh-sync-token',
      });

    await syncGoogleCalendarList(account.id, {
      repo,
      getAccessToken: async () => 'access-token',
      fetchCalendarListPage,
    });

    expect(fetchCalendarListPage).toHaveBeenNthCalledWith(1, 'access-token', {
      pageToken: null,
      syncToken: 'expired-sync-token',
    });
    expect(fetchCalendarListPage).toHaveBeenNthCalledWith(2, 'access-token', {
      pageToken: null,
      syncToken: null,
    });
    expect(repo.getCalendarByGoogleId(account.id, 'stale')).toBeNull();
    expect(repo.getCalendarByGoogleId(account.id, 'primary')).toEqual(
      expect.objectContaining({ selected: 1 }),
    );
  });

  it('syncs selected calendar events with a rolling window and no Events syncToken', async () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);
    const fetchEventsPage = jest.fn().mockResolvedValue({
      items: [
        {
          id: 'event-1',
          summary: 'Planning',
          start: { dateTime: '2026-06-23T12:30:00.000Z' },
          end: { dateTime: '2026-06-23T13:00:00.000Z' },
          attendees: [{ email: 'person@example.com', displayName: 'Person' }],
        },
      ],
    });

    await syncSelectedGoogleCalendarEventWindow(account.id, {
      repo,
      getAccessToken: async () => 'access-token',
      fetchEventsPage,
      now: () => new Date('2026-06-23T12:00:00.000Z'),
    });

    expect(fetchEventsPage).toHaveBeenCalledWith('access-token', {
      calendarId: 'primary',
      timeMin: '2026-06-23T11:45:00.000Z',
      timeMax: '2026-06-30T12:00:00.000Z',
      pageToken: null,
    });
    expect(fetchEventsPage.mock.calls[0][1]).not.toHaveProperty('syncToken');
    const stored = db
      .select()
      .from(googleCalendarEvents)
      .where(eq(googleCalendarEvents.googleEventId, 'event-1'))
      .get();
    expect(stored).toEqual(
      expect.objectContaining({
        summary: 'Planning',
      }),
    );
    expect(JSON.parse(stored?.attendeesJson ?? '[]')).toEqual([
      expect.objectContaining({ email: 'person@example.com', displayName: 'Person' }),
    ]);
  });

  it('marks accounts needs_reconnect when Google Events API rejects credentials', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);

    await expect(
      syncSelectedGoogleCalendarEventWindow(account.id, {
        repo,
        getAccessToken: async () => 'access-token',
        fetchEventsPage: jest
          .fn()
          .mockRejectedValue(new GoogleCalendarApiError('Unauthorized', 401)),
      }),
    ).rejects.toThrow('Unauthorized');

    expect(repo.getAccountById(account.id)).toEqual(
      expect.objectContaining({
        status: 'needs_reconnect',
        lastError: 'Unauthorized',
      }),
    );
  });

  it('keeps Google Events API 403 failures as retryable errors, not reconnect prompts', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);

    await expect(
      syncSelectedGoogleCalendarEventWindow(account.id, {
        repo,
        getAccessToken: async () => 'access-token',
        fetchEventsPage: jest
          .fn()
          .mockRejectedValue(new GoogleCalendarApiError('Rate Limit Exceeded', 403)),
      }),
    ).rejects.toThrow('Rate Limit Exceeded');

    expect(repo.getAccountById(account.id)).toEqual(
      expect.objectContaining({
        status: 'error',
        lastError: 'Rate Limit Exceeded',
      }),
    );
  });

  it('marks and reports generic access-token failures before sync requests start', async () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    const fetchCalendarListPage = jest.fn();

    await expect(
      syncGoogleCalendarList(account.id, {
        repo,
        getAccessToken: async () => {
          throw new Error('Network request failed');
        },
        fetchCalendarListPage,
      }),
    ).rejects.toThrow('Network request failed');

    expect(fetchCalendarListPage).not.toHaveBeenCalled();
    expect(repo.getAccountById(account.id)).toEqual(
      expect.objectContaining({
        status: 'error',
        lastError: 'Network request failed',
      }),
    );
  });
});
