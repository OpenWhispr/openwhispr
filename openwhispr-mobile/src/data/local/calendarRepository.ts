import { and, asc, desc, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm';
import {
  googleCalendarAccounts,
  googleCalendarEvents,
  googleCalendars,
  googleCalendarSyncState,
} from '@/db/schema';
import type {
  CalendarRepository,
  GoogleCalendar,
  GoogleCalendarAccount,
  GoogleCalendarAccountStatus,
  GoogleCalendarEvent,
  ReplaceGoogleCalendarEventsWindowInput,
  UpsertGoogleCalendarAccountInput,
  UpsertGoogleCalendarInput,
} from '../calendarTypes';

type CalendarDb = typeof import('@/db').db;

const getDefaultDb = (): CalendarDb => {
  const { db } = require('@/db') as typeof import('@/db');
  return db;
};

const boolToInt = (value: boolean | undefined): 0 | 1 => (value ? 1 : 0);

export class LocalCalendarRepository implements CalendarRepository {
  private readonly database: CalendarDb;

  constructor(database?: CalendarDb) {
    this.database = database ?? getDefaultDb();
  }

  getAccounts(): GoogleCalendarAccount[] {
    return this.database
      .select()
      .from(googleCalendarAccounts)
      .orderBy(asc(googleCalendarAccounts.email), asc(googleCalendarAccounts.id))
      .all();
  }

  getAccountById(id: number): GoogleCalendarAccount | null {
    return (
      this.database
        .select()
        .from(googleCalendarAccounts)
        .where(eq(googleCalendarAccounts.id, id))
        .get() ?? null
    );
  }

  getAccountByGoogleSubject(googleSubject: string): GoogleCalendarAccount | null {
    return (
      this.database
        .select()
        .from(googleCalendarAccounts)
        .where(eq(googleCalendarAccounts.googleSubject, googleSubject))
        .get() ?? null
    );
  }

  upsertAccount(input: UpsertGoogleCalendarAccountInput): GoogleCalendarAccount {
    const existing = this.getAccountByGoogleSubject(input.googleSubject);
    const values = {
      email: input.email ?? null,
      displayName: input.displayName ?? null,
      grantedScopes: input.grantedScopes ?? null,
      status: input.status ?? 'connected',
      lastSyncAt: input.lastSyncAt ?? null,
      lastError: input.lastError ?? null,
      updatedAt: sql`datetime('now')`,
    };

    if (!existing) {
      return this.database
        .insert(googleCalendarAccounts)
        .values({ googleSubject: input.googleSubject, ...values })
        .returning()
        .get();
    }

    this.database
      .update(googleCalendarAccounts)
      .set(values)
      .where(eq(googleCalendarAccounts.id, existing.id))
      .run();
    return this.getAccountById(existing.id)!;
  }

  updateAccountStatus(
    accountId: number,
    status: GoogleCalendarAccountStatus,
    lastError: string | null = null,
  ): void {
    this.database
      .update(googleCalendarAccounts)
      .set({ status, lastError, updatedAt: sql`datetime('now')` })
      .where(eq(googleCalendarAccounts.id, accountId))
      .run();
  }

  markAccountSynced(accountId: number, syncedAt: string): void {
    this.database
      .update(googleCalendarAccounts)
      .set({
        status: 'connected',
        lastSyncAt: syncedAt,
        lastError: null,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(googleCalendarAccounts.id, accountId))
      .run();
  }

  deleteAccountData(accountId: number): void {
    this.database.transaction((tx) => {
      tx.delete(googleCalendarEvents).where(eq(googleCalendarEvents.accountId, accountId)).run();
      tx.delete(googleCalendarSyncState)
        .where(eq(googleCalendarSyncState.accountId, accountId))
        .run();
      tx.delete(googleCalendars).where(eq(googleCalendars.accountId, accountId)).run();
      tx.delete(googleCalendarAccounts).where(eq(googleCalendarAccounts.id, accountId)).run();
    });
  }

  getCalendars(accountId: number): GoogleCalendar[] {
    return this.database
      .select()
      .from(googleCalendars)
      .where(eq(googleCalendars.accountId, accountId))
      .orderBy(desc(googleCalendars.isPrimary), asc(googleCalendars.summary))
      .all();
  }

  getSelectedCalendars(accountId: number): GoogleCalendar[] {
    return this.database
      .select()
      .from(googleCalendars)
      .where(
        and(
          eq(googleCalendars.accountId, accountId),
          eq(googleCalendars.selected, 1),
          sql`${googleCalendars.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(googleCalendars.isPrimary), asc(googleCalendars.summary))
      .all();
  }

  getCalendarByGoogleId(accountId: number, googleCalendarId: string): GoogleCalendar | null {
    return (
      this.database
        .select()
        .from(googleCalendars)
        .where(
          and(
            eq(googleCalendars.accountId, accountId),
            eq(googleCalendars.googleCalendarId, googleCalendarId),
          ),
        )
        .get() ?? null
    );
  }

  upsertCalendars(accountId: number, calendars: UpsertGoogleCalendarInput[]): GoogleCalendar[] {
    for (const calendar of calendars) {
      const existing = this.getCalendarByGoogleId(accountId, calendar.googleCalendarId);
      const isPrimary = boolToInt(calendar.isPrimary);
      const selected =
        calendar.selected === undefined
          ? (existing?.selected ?? isPrimary)
          : boolToInt(calendar.selected);
      const values = {
        summary: calendar.summary ?? null,
        isPrimary,
        accessRole: calendar.accessRole ?? null,
        selected,
        deletedAt: null,
        updatedAt: sql`datetime('now')`,
      };

      if (!existing) {
        this.database
          .insert(googleCalendars)
          .values({
            accountId,
            googleCalendarId: calendar.googleCalendarId,
            ...values,
          })
          .run();
        continue;
      }

      this.database
        .update(googleCalendars)
        .set(values)
        .where(eq(googleCalendars.id, existing.id))
        .run();
    }

    return this.getCalendars(accountId);
  }

  markCalendarsDeletedExcept(accountId: number, activeGoogleCalendarIds: string[]): void {
    const baseCondition =
      activeGoogleCalendarIds.length === 0
        ? eq(googleCalendars.accountId, accountId)
        : and(
            eq(googleCalendars.accountId, accountId),
            notInArray(googleCalendars.googleCalendarId, activeGoogleCalendarIds),
          );

    this.database.transaction((tx) => {
      const deletedCalendars = tx
        .select({ id: googleCalendars.id })
        .from(googleCalendars)
        .where(baseCondition)
        .all();
      const calendarLocalIds = deletedCalendars.map((calendar) => calendar.id);
      if (calendarLocalIds.length > 0) {
        tx.delete(googleCalendarEvents)
          .where(inArray(googleCalendarEvents.calendarLocalId, calendarLocalIds))
          .run();
      }
      tx.update(googleCalendars)
        .set({ deletedAt: sql`datetime('now')`, selected: 0, updatedAt: sql`datetime('now')` })
        .where(baseCondition)
        .run();
    });
  }

  markCalendarsDeleted(accountId: number, googleCalendarIds: string[]): void {
    if (googleCalendarIds.length === 0) return;
    this.database.transaction((tx) => {
      const calendarLocalIds = tx
        .select({ id: googleCalendars.id })
        .from(googleCalendars)
        .where(
          and(
            eq(googleCalendars.accountId, accountId),
            inArray(googleCalendars.googleCalendarId, googleCalendarIds),
          ),
        )
        .all()
        .map((calendar) => calendar.id);
      if (calendarLocalIds.length > 0) {
        tx.delete(googleCalendarEvents)
          .where(inArray(googleCalendarEvents.calendarLocalId, calendarLocalIds))
          .run();
      }
      tx.update(googleCalendars)
        .set({ deletedAt: sql`datetime('now')`, selected: 0, updatedAt: sql`datetime('now')` })
        .where(
          and(
            eq(googleCalendars.accountId, accountId),
            inArray(googleCalendars.googleCalendarId, googleCalendarIds),
          ),
        )
        .run();
    });
  }

  setCalendarSelected(calendarLocalId: number, selected: boolean): void {
    this.database.transaction((tx) => {
      tx.update(googleCalendars)
        .set({ selected: boolToInt(selected), updatedAt: sql`datetime('now')` })
        .where(eq(googleCalendars.id, calendarLocalId))
        .run();
      if (!selected) {
        tx.delete(googleCalendarEvents)
          .where(eq(googleCalendarEvents.calendarLocalId, calendarLocalId))
          .run();
      }
    });
  }

  clearCalendarCacheForAccount(accountId: number): void {
    this.database.transaction((tx) => {
      tx.delete(googleCalendarEvents).where(eq(googleCalendarEvents.accountId, accountId)).run();
      tx.delete(googleCalendars).where(eq(googleCalendars.accountId, accountId)).run();
      tx.delete(googleCalendarSyncState)
        .where(
          and(
            eq(googleCalendarSyncState.accountId, accountId),
            eq(googleCalendarSyncState.resourceType, 'calendar_list'),
          ),
        )
        .run();
    });
  }

  getCalendarListSyncToken(accountId: number): string | null {
    return (
      this.database
        .select({ syncToken: googleCalendarSyncState.syncToken })
        .from(googleCalendarSyncState)
        .where(
          and(
            eq(googleCalendarSyncState.accountId, accountId),
            eq(googleCalendarSyncState.resourceType, 'calendar_list'),
          ),
        )
        .get()?.syncToken ?? null
    );
  }

  setCalendarListSyncToken(accountId: number, syncToken: string | null): void {
    const existing = this.database
      .select()
      .from(googleCalendarSyncState)
      .where(
        and(
          eq(googleCalendarSyncState.accountId, accountId),
          eq(googleCalendarSyncState.resourceType, 'calendar_list'),
        ),
      )
      .get();

    if (!existing) {
      this.database
        .insert(googleCalendarSyncState)
        .values({ accountId, resourceType: 'calendar_list', syncToken })
        .run();
      return;
    }

    this.database
      .update(googleCalendarSyncState)
      .set({ syncToken, updatedAt: sql`datetime('now')` })
      .where(
        and(
          eq(googleCalendarSyncState.accountId, accountId),
          eq(googleCalendarSyncState.resourceType, 'calendar_list'),
        ),
      )
      .run();
  }

  clearCalendarListSyncToken(accountId: number): void {
    this.database
      .delete(googleCalendarSyncState)
      .where(
        and(
          eq(googleCalendarSyncState.accountId, accountId),
          eq(googleCalendarSyncState.resourceType, 'calendar_list'),
        ),
      )
      .run();
  }

  replaceEventsForCalendarWindow(input: ReplaceGoogleCalendarEventsWindowInput): void {
    this.database.transaction((tx) => {
      tx.delete(googleCalendarEvents)
        .where(
          and(
            eq(googleCalendarEvents.accountId, input.accountId),
            eq(googleCalendarEvents.calendarLocalId, input.calendarLocalId),
            lt(googleCalendarEvents.startAt, input.windowEnd),
            gt(googleCalendarEvents.endAt, input.windowStart),
          ),
        )
        .run();

      if (input.events.length === 0) return;

      // Upsert on the event's identity. The window-delete above only removes rows whose stored
      // times still overlap the window, so a rescheduled event (or one returned across calendars)
      // can survive it; a plain insert would then hit the unique index. Re-mirror it in place.
      tx.insert(googleCalendarEvents)
        .values(
          input.events.map((event) => ({
            accountId: input.accountId,
            calendarLocalId: input.calendarLocalId,
            googleCalendarId: input.googleCalendarId,
            googleEventId: event.googleEventId,
            iCalUID: event.iCalUID ?? null,
            summary: event.summary ?? null,
            description: event.description ?? null,
            location: event.location ?? null,
            startAt: event.startAt,
            endAt: event.endAt,
            allDay: boolToInt(event.allDay),
            status: event.status ?? null,
            organizerEmail: event.organizerEmail ?? null,
            creatorEmail: event.creatorEmail ?? null,
            attendeesJson: event.attendees ? JSON.stringify(event.attendees) : null,
            updated: event.updated ?? null,
            htmlLink: event.htmlLink ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            googleCalendarEvents.accountId,
            googleCalendarEvents.googleCalendarId,
            googleCalendarEvents.googleEventId,
          ],
          set: {
            calendarLocalId: sql`excluded.calendar_local_id`,
            iCalUID: sql`excluded.ical_uid`,
            summary: sql`excluded.summary`,
            description: sql`excluded.description`,
            location: sql`excluded.location`,
            startAt: sql`excluded.start_at`,
            endAt: sql`excluded.end_at`,
            allDay: sql`excluded.all_day`,
            status: sql`excluded.status`,
            organizerEmail: sql`excluded.organizer_email`,
            creatorEmail: sql`excluded.creator_email`,
            attendeesJson: sql`excluded.attendees_json`,
            updated: sql`excluded.updated`,
            htmlLink: sql`excluded.html_link`,
            updatedAt: sql`(datetime('now'))`,
          },
        })
        .run();
    });
  }

  getUpcomingEvents(accountId: number, fromIso: string, toIso: string): GoogleCalendarEvent[] {
    return this.database
      .select()
      .from(googleCalendarEvents)
      .where(
        and(
          eq(googleCalendarEvents.accountId, accountId),
          gt(googleCalendarEvents.endAt, fromIso),
          lt(googleCalendarEvents.startAt, toIso),
          sql`EXISTS (
            SELECT 1 FROM ${googleCalendars}
            WHERE ${googleCalendars.id} = ${googleCalendarEvents.calendarLocalId}
              AND ${googleCalendars.selected} = 1
              AND ${googleCalendars.deletedAt} IS NULL
          )`,
        ),
      )
      .orderBy(asc(googleCalendarEvents.startAt), asc(googleCalendarEvents.summary))
      .all();
  }
}
