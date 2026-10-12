import { eq } from 'drizzle-orm';
import {
  googleCalendarAccounts,
  googleCalendarEvents,
  googleCalendars,
  googleCalendarSyncState,
} from '@/db/schema';
import { LocalCalendarRepository } from '../calendarRepository';
import { createMemoryRepository } from './testDb';

const createCalendarRepo = () => {
  const { db } = createMemoryRepository();
  return {
    db,
    repo: new LocalCalendarRepository(
      db as unknown as ConstructorParameters<typeof LocalCalendarRepository>[0],
    ),
  };
};

describe('LocalCalendarRepository', () => {
  it('upserts accounts and preserves the stable Google subject key', () => {
    const { repo } = createCalendarRepo();

    const created = repo.upsertAccount({
      googleSubject: 'google-sub-1',
      email: 'old@example.com',
      displayName: 'Old Name',
      grantedScopes: 'openid email',
    });
    const updated = repo.upsertAccount({
      googleSubject: 'google-sub-1',
      email: 'new@example.com',
      displayName: 'New Name',
      grantedScopes: 'openid email calendar',
    });

    expect(updated.id).toBe(created.id);
    expect(updated).toEqual(
      expect.objectContaining({
        googleSubject: 'google-sub-1',
        email: 'new@example.com',
        displayName: 'New Name',
        status: 'connected',
      }),
    );
    expect(repo.getAccounts()).toHaveLength(1);
  });

  it('selects primary calendars by default and preserves existing manual selection', () => {
    const { repo } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });

    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'primary', summary: 'Primary', isPrimary: true },
      { googleCalendarId: 'team', summary: 'Team', isPrimary: false },
    ]);
    const team = repo.getCalendarByGoogleId(account.id, 'team')!;
    repo.setCalendarSelected(team.id, true);

    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'primary', summary: 'Primary Renamed', isPrimary: true },
      { googleCalendarId: 'team', summary: 'Team Renamed', isPrimary: false },
    ]);

    expect(repo.getCalendarByGoogleId(account.id, 'primary')).toEqual(
      expect.objectContaining({ selected: 1, summary: 'Primary Renamed' }),
    );
    expect(repo.getCalendarByGoogleId(account.id, 'team')).toEqual(
      expect.objectContaining({ selected: 1, summary: 'Team Renamed' }),
    );
  });

  it('manually deletes event rows when calendars are marked deleted', () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'keep', summary: 'Keep', selected: true },
      { googleCalendarId: 'delete', summary: 'Delete', selected: true },
    ]);
    const keep = repo.getCalendarByGoogleId(account.id, 'keep')!;
    const deleted = repo.getCalendarByGoogleId(account.id, 'delete')!;
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: keep.id,
      googleCalendarId: keep.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: keep.googleCalendarId,
          googleEventId: 'keep-event',
          startAt: '2026-06-24T10:00:00.000Z',
          endAt: '2026-06-24T11:00:00.000Z',
        },
      ],
    });
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: deleted.id,
      googleCalendarId: deleted.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: deleted.googleCalendarId,
          googleEventId: 'deleted-event',
          startAt: '2026-06-24T12:00:00.000Z',
          endAt: '2026-06-24T13:00:00.000Z',
        },
      ],
    });

    repo.markCalendarsDeleted(account.id, ['delete']);

    expect(repo.getCalendarByGoogleId(account.id, 'delete')).toEqual(
      expect.objectContaining({ selected: 0 }),
    );
    expect(
      db
        .select()
        .from(googleCalendarEvents)
        .where(eq(googleCalendarEvents.googleEventId, 'deleted-event'))
        .all(),
    ).toEqual([]);
    expect(
      db
        .select()
        .from(googleCalendarEvents)
        .where(eq(googleCalendarEvents.googleEventId, 'keep-event'))
        .all(),
    ).toHaveLength(1);
  });

  it('replaces only events overlapping the rolling window and preserves null attendees', () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);
    const calendar = repo.getCalendarByGoogleId(account.id, 'primary')!;

    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: calendar.id,
      googleCalendarId: calendar.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: calendar.googleCalendarId,
          googleEventId: 'inside',
          startAt: '2026-06-24T10:00:00.000Z',
          endAt: '2026-06-24T11:00:00.000Z',
          attendees: null,
        },
        {
          googleCalendarId: calendar.googleCalendarId,
          googleEventId: 'after',
          startAt: '2026-07-01T10:00:00.000Z',
          endAt: '2026-07-01T11:00:00.000Z',
        },
      ],
    });
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: calendar.id,
      googleCalendarId: calendar.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [],
    });

    expect(
      db
        .select()
        .from(googleCalendarEvents)
        .where(eq(googleCalendarEvents.googleEventId, 'inside'))
        .all(),
    ).toEqual([]);
    expect(
      db
        .select()
        .from(googleCalendarEvents)
        .where(eq(googleCalendarEvents.googleEventId, 'after'))
        .all(),
    ).toHaveLength(1);
  });

  it('upserts an event whose stored row no longer overlaps the sync window (rescheduled across syncs)', () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);
    const calendar = repo.getCalendarByGoogleId(account.id, 'primary')!;

    // First sync: the event lives in early June and is stored.
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: calendar.id,
      googleCalendarId: calendar.googleCalendarId,
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-06-08T00:00:00.000Z',
      events: [
        {
          googleCalendarId: calendar.googleCalendarId,
          googleEventId: 'evt',
          startAt: '2026-06-02T10:00:00.000Z',
          endAt: '2026-06-02T11:00:00.000Z',
          summary: 'June slot',
        },
      ],
    });

    // The event is rescheduled to July. The next sync window no longer overlaps the stored row, so
    // the window-delete cannot remove it — but Google still returns the event. The write must
    // upsert the surviving row, not throw a UNIQUE constraint error.
    expect(() =>
      repo.replaceEventsForCalendarWindow({
        accountId: account.id,
        calendarLocalId: calendar.id,
        googleCalendarId: calendar.googleCalendarId,
        windowStart: '2026-07-01T00:00:00.000Z',
        windowEnd: '2026-07-08T00:00:00.000Z',
        events: [
          {
            googleCalendarId: calendar.googleCalendarId,
            googleEventId: 'evt',
            startAt: '2026-07-02T10:00:00.000Z',
            endAt: '2026-07-02T11:00:00.000Z',
            summary: 'July slot',
          },
        ],
      }),
    ).not.toThrow();

    const rows = db
      .select()
      .from(googleCalendarEvents)
      .where(eq(googleCalendarEvents.googleEventId, 'evt'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ startAt: '2026-07-02T10:00:00.000Z', summary: 'July slot' }),
    );
  });

  it('clears cached events and hides suggestions when a calendar is deselected', () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [
      { googleCalendarId: 'team', summary: 'Team', selected: true },
    ]);
    const calendar = repo.getCalendarByGoogleId(account.id, 'team')!;
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: calendar.id,
      googleCalendarId: calendar.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: calendar.googleCalendarId,
          googleEventId: 'team-event',
          startAt: '2026-06-24T10:00:00.000Z',
          endAt: '2026-06-24T11:00:00.000Z',
        },
      ],
    });

    expect(
      repo.getUpcomingEvents(account.id, '2026-06-23T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
    ).toHaveLength(1);

    repo.setCalendarSelected(calendar.id, false);

    expect(db.select().from(googleCalendarEvents).all()).toEqual([]);
    expect(
      repo.getUpcomingEvents(account.id, '2026-06-23T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
    ).toEqual([]);
  });

  it('manually deletes all child calendar rows when deleting an account', () => {
    const { repo, db } = createCalendarRepo();
    const account = repo.upsertAccount({ googleSubject: 'google-sub-1' });
    repo.upsertCalendars(account.id, [{ googleCalendarId: 'primary', selected: true }]);
    const calendar = repo.getCalendarByGoogleId(account.id, 'primary')!;
    repo.setCalendarListSyncToken(account.id, 'sync-token');
    repo.replaceEventsForCalendarWindow({
      accountId: account.id,
      calendarLocalId: calendar.id,
      googleCalendarId: calendar.googleCalendarId,
      windowStart: '2026-06-23T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      events: [
        {
          googleCalendarId: calendar.googleCalendarId,
          googleEventId: 'event',
          startAt: '2026-06-24T10:00:00.000Z',
          endAt: '2026-06-24T11:00:00.000Z',
        },
      ],
    });

    repo.deleteAccountData(account.id);

    expect(db.select().from(googleCalendarAccounts).all()).toEqual([]);
    expect(db.select().from(googleCalendars).all()).toEqual([]);
    expect(db.select().from(googleCalendarEvents).all()).toEqual([]);
    expect(db.select().from(googleCalendarSyncState).all()).toEqual([]);
  });
});
