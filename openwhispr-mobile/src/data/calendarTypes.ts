import type {
  googleCalendarAccounts,
  googleCalendarEvents,
  googleCalendars,
  googleCalendarSyncState,
} from '@/db/schema';

export type GoogleCalendarAccountStatus = 'connected' | 'needs_reconnect' | 'error';
export type GoogleCalendarSyncResourceType = 'calendar_list';

export type GoogleCalendarAccount = typeof googleCalendarAccounts.$inferSelect;
export type GoogleCalendar = typeof googleCalendars.$inferSelect;
export type GoogleCalendarSyncState = typeof googleCalendarSyncState.$inferSelect;
export type GoogleCalendarEvent = typeof googleCalendarEvents.$inferSelect;

export interface CalendarParticipant {
  email: string | null;
  displayName: string | null;
  responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  optional: boolean;
  organizer: boolean;
  resource: boolean;
  self: boolean;
}

export interface UpsertGoogleCalendarAccountInput {
  googleSubject: string;
  email?: string | null;
  displayName?: string | null;
  grantedScopes?: string | null;
  status?: GoogleCalendarAccountStatus;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

export interface UpsertGoogleCalendarInput {
  googleCalendarId: string;
  summary?: string | null;
  isPrimary?: boolean;
  accessRole?: string | null;
  selected?: boolean;
}

export interface UpsertGoogleCalendarEventInput {
  googleCalendarId: string;
  googleEventId: string;
  iCalUID?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  status?: string | null;
  organizerEmail?: string | null;
  creatorEmail?: string | null;
  attendees?: CalendarParticipant[] | null;
  updated?: string | null;
  htmlLink?: string | null;
}

export interface ReplaceGoogleCalendarEventsWindowInput {
  accountId: number;
  calendarLocalId: number;
  googleCalendarId: string;
  windowStart: string;
  windowEnd: string;
  events: UpsertGoogleCalendarEventInput[];
}

export interface CalendarRepository {
  getAccounts(): GoogleCalendarAccount[];
  getAccountById(id: number): GoogleCalendarAccount | null;
  getAccountByGoogleSubject(googleSubject: string): GoogleCalendarAccount | null;
  upsertAccount(input: UpsertGoogleCalendarAccountInput): GoogleCalendarAccount;
  updateAccountStatus(
    accountId: number,
    status: GoogleCalendarAccountStatus,
    lastError?: string | null,
  ): void;
  markAccountSynced(accountId: number, syncedAt: string): void;
  deleteAccountData(accountId: number): void;

  getCalendars(accountId: number): GoogleCalendar[];
  getSelectedCalendars(accountId: number): GoogleCalendar[];
  getCalendarByGoogleId(accountId: number, googleCalendarId: string): GoogleCalendar | null;
  upsertCalendars(accountId: number, calendars: UpsertGoogleCalendarInput[]): GoogleCalendar[];
  markCalendarsDeleted(accountId: number, googleCalendarIds: string[]): void;
  markCalendarsDeletedExcept(accountId: number, activeGoogleCalendarIds: string[]): void;
  setCalendarSelected(calendarLocalId: number, selected: boolean): void;
  clearCalendarCacheForAccount(accountId: number): void;

  getCalendarListSyncToken(accountId: number): string | null;
  setCalendarListSyncToken(accountId: number, syncToken: string | null): void;
  clearCalendarListSyncToken(accountId: number): void;

  replaceEventsForCalendarWindow(input: ReplaceGoogleCalendarEventsWindowInput): void;
  getUpcomingEvents(accountId: number, fromIso: string, toIso: string): GoogleCalendarEvent[];
}
