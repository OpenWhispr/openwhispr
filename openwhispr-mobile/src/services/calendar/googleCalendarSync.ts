import type {
  CalendarParticipant,
  CalendarRepository,
  GoogleCalendarAccount,
  UpsertGoogleCalendarEventInput,
  UpsertGoogleCalendarInput,
} from '@/data/calendarTypes';
import { calendarRepository } from '@/data/calendarRepository';
import {
  fetchGoogleCalendarEventsPage,
  fetchGoogleCalendarListPage,
  GoogleCalendarApiError,
  type RawGoogleCalendarAttendee,
  type RawGoogleCalendarEvent,
  type RawGoogleCalendarListEntry,
} from './googleCalendarApi';
import { getGoogleCalendarClientId, getGoogleCalendarRequiredScopes } from './googleCalendarConfig';
import {
  GoogleCalendarAuthError,
  hasRequiredGoogleCalendarScopes,
  refreshStoredGoogleCalendarToken,
} from './googleCalendarAuth';
import {
  addGoogleCalendarBreadcrumb,
  captureGoogleCalendarException,
} from './googleCalendarTelemetry';

const EVENT_WINDOW_PAST_MS = 15 * 60 * 1000;
const EVENT_WINDOW_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;
const GOOGLE_AUTH_RECONNECT_CODES = new Set([
  'invalid_grant',
  'missing_refresh_token',
  'missing_tokens',
  'missing_required_scopes',
]);
const GOOGLE_API_RECONNECT_STATUSES = new Set([401]);

interface SyncDeps {
  repo?: CalendarRepository;
  now?: () => Date;
  getAccessToken?: (account: GoogleCalendarAccount) => Promise<string>;
  fetchCalendarListPage?: typeof fetchGoogleCalendarListPage;
  fetchEventsPage?: typeof fetchGoogleCalendarEventsPage;
}

const normalizeEmail = (email: string | null | undefined): string | null => {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
};

const normalizeDisplayName = (displayName: string | null | undefined): string | null => {
  const trimmed = displayName?.trim();
  return trimmed || null;
};

const messageForError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const statusForSyncError = (error: unknown): GoogleCalendarAccount['status'] =>
  error instanceof GoogleCalendarApiError && GOOGLE_API_RECONNECT_STATUSES.has(error.status)
    ? 'needs_reconnect'
    : 'error';

const googleApiStatusTag = (error: unknown): number | undefined =>
  error instanceof GoogleCalendarApiError ? error.status : undefined;

const normalizeAttendee = (attendee: RawGoogleCalendarAttendee): CalendarParticipant | null => {
  const email = normalizeEmail(attendee.email);
  const displayName = normalizeDisplayName(attendee.displayName);
  if (!email && !displayName) return null;
  return {
    email,
    displayName,
    responseStatus: attendee.responseStatus ?? null,
    optional: !!attendee.optional,
    organizer: !!attendee.organizer,
    resource: !!attendee.resource,
    self: !!attendee.self,
  };
};

export function normalizeCalendarParticipants(
  event: RawGoogleCalendarEvent,
): CalendarParticipant[] {
  const participants = new Map<string, CalendarParticipant>();
  for (const attendee of event.attendees ?? []) {
    const normalized = normalizeAttendee(attendee);
    if (!normalized) continue;
    const key = normalized.email ?? normalized.displayName?.toLowerCase();
    if (!key) continue;
    participants.set(key, normalized);
  }

  const organizerEmail = normalizeEmail(event.organizer?.email);
  if (organizerEmail && !participants.has(organizerEmail)) {
    participants.set(organizerEmail, {
      email: organizerEmail,
      displayName: normalizeDisplayName(event.organizer?.displayName),
      responseStatus: 'accepted',
      optional: false,
      organizer: true,
      resource: false,
      self: !!event.organizer?.self,
    });
  }

  return [...participants.values()];
}

const parseGoogleEventTime = (
  value: { date?: string; dateTime?: string } | undefined,
): { iso: string; allDay: boolean } | null => {
  if (value?.dateTime) return { iso: new Date(value.dateTime).toISOString(), allDay: false };
  if (value?.date) return { iso: `${value.date}T00:00:00.000Z`, allDay: true };
  return null;
};

export function normalizeCalendarListEntry(
  entry: RawGoogleCalendarListEntry,
): UpsertGoogleCalendarInput | null {
  if (!entry.id || entry.deleted) return null;
  return {
    googleCalendarId: entry.id,
    summary: entry.summary ?? null,
    isPrimary: !!entry.primary,
    accessRole: entry.accessRole ?? null,
    selected: entry.primary ? true : undefined,
  };
}

export function normalizeCalendarEvent(
  event: RawGoogleCalendarEvent,
  googleCalendarId: string,
): UpsertGoogleCalendarEventInput | null {
  if (!event.id || event.status === 'cancelled') return null;
  const start = parseGoogleEventTime(event.start);
  const end = parseGoogleEventTime(event.end) ?? start;
  if (!start || !end) return null;
  const summary = event.visibility === 'private' && !event.summary ? 'Busy' : event.summary;

  return {
    googleCalendarId,
    googleEventId: event.id,
    iCalUID: event.iCalUID ?? null,
    summary: summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    startAt: start.iso,
    endAt: end.iso,
    allDay: start.allDay,
    status: event.status ?? null,
    organizerEmail: normalizeEmail(event.organizer?.email),
    creatorEmail: normalizeEmail(event.creator?.email),
    attendees: normalizeCalendarParticipants(event),
    updated: event.updated ?? null,
    htmlLink: event.htmlLink ?? null,
  };
}

async function getFreshAccessToken(account: GoogleCalendarAccount): Promise<string> {
  const clientId = getGoogleCalendarClientId();
  if (!clientId) {
    throw new GoogleCalendarAuthError(
      'missing_client_id',
      'Google Calendar OAuth client id is not configured',
    );
  }
  if (!hasRequiredGoogleCalendarScopes(account.grantedScopes)) {
    throw new GoogleCalendarAuthError(
      'missing_required_scopes',
      `Google Calendar requires scopes: ${getGoogleCalendarRequiredScopes().join(' ')}`,
    );
  }
  const refreshed = await refreshStoredGoogleCalendarToken({
    clientId,
    googleSubject: account.googleSubject,
  });
  return refreshed.accessToken;
}

async function resolveAccessTokenForSync(
  account: GoogleCalendarAccount,
  repo: CalendarRepository,
  getAccessToken: (account: GoogleCalendarAccount) => Promise<string>,
): Promise<string> {
  try {
    return await getAccessToken(account);
  } catch (error) {
    if (error instanceof GoogleCalendarAuthError) {
      const nextStatus = GOOGLE_AUTH_RECONNECT_CODES.has(error.code) ? 'needs_reconnect' : 'error';
      repo.updateAccountStatus(account.id, nextStatus, error.message);
      captureGoogleCalendarException(error, 'access_token', {
        google_calendar_error_code: error.code,
        google_calendar_account_status: nextStatus,
      });
    } else {
      repo.updateAccountStatus(
        account.id,
        'error',
        messageForError(error, 'Failed to refresh Google Calendar access token'),
      );
      captureGoogleCalendarException(error, 'access_token', {
        google_calendar_account_status: 'error',
      });
    }
    throw error;
  }
}

export async function syncGoogleCalendarList(
  accountId: number,
  deps: SyncDeps = {},
): Promise<void> {
  const repo = deps.repo ?? calendarRepository;
  const account = repo.getAccountById(accountId);
  if (!account) throw new Error(`Google Calendar account ${accountId} not found`);
  const accessToken = await resolveAccessTokenForSync(
    account,
    repo,
    deps.getAccessToken ?? getFreshAccessToken,
  );
  const fetchPage = deps.fetchCalendarListPage ?? fetchGoogleCalendarListPage;

  let pageToken: string | null = null;
  const initialSyncToken = repo.getCalendarListSyncToken(accountId);
  let syncToken = initialSyncToken;
  let nextSyncToken: string | null = null;
  const activeCalendarIds: string[] = [];
  const deletedCalendarIds: string[] = [];

  try {
    do {
      const page = await fetchPage(accessToken, { pageToken, syncToken });
      deletedCalendarIds.push(
        ...(page.items ?? [])
          .filter((entry) => entry.deleted && entry.id)
          .map((entry) => entry.id!),
      );
      const calendars = (page.items ?? [])
        .map(normalizeCalendarListEntry)
        .filter((calendar): calendar is UpsertGoogleCalendarInput => !!calendar);
      activeCalendarIds.push(...calendars.map((calendar) => calendar.googleCalendarId));
      repo.upsertCalendars(accountId, calendars);
      pageToken = page.nextPageToken ?? null;
      syncToken = null;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof GoogleCalendarApiError && error.status === 410) {
      addGoogleCalendarBreadcrumb('calendar_list_sync_token_expired');
      repo.clearCalendarCacheForAccount(accountId);
      await syncGoogleCalendarList(accountId, {
        ...deps,
        repo,
        getAccessToken: async () => accessToken,
      });
      return;
    }
    const nextStatus = statusForSyncError(error);
    repo.updateAccountStatus(accountId, nextStatus, messageForError(error, 'Sync failed'));
    captureGoogleCalendarException(error, 'calendar_list_sync', {
      google_calendar_http_status: googleApiStatusTag(error),
      google_calendar_account_status: nextStatus,
    });
    throw error;
  }

  if (initialSyncToken) {
    repo.markCalendarsDeleted(accountId, deletedCalendarIds);
  } else {
    repo.markCalendarsDeletedExcept(accountId, activeCalendarIds);
  }
  if (nextSyncToken !== null) repo.setCalendarListSyncToken(accountId, nextSyncToken);
  repo.markAccountSynced(accountId, (deps.now?.() ?? new Date()).toISOString());
}

export async function syncSelectedGoogleCalendarEventWindow(
  accountId: number,
  deps: SyncDeps = {},
): Promise<void> {
  const repo = deps.repo ?? calendarRepository;
  const account = repo.getAccountById(accountId);
  if (!account) throw new Error(`Google Calendar account ${accountId} not found`);
  const accessToken = await resolveAccessTokenForSync(
    account,
    repo,
    deps.getAccessToken ?? getFreshAccessToken,
  );
  const fetchPage = deps.fetchEventsPage ?? fetchGoogleCalendarEventsPage;
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(now.getTime() - EVENT_WINDOW_PAST_MS).toISOString();
  const windowEnd = new Date(now.getTime() + EVENT_WINDOW_FUTURE_MS).toISOString();

  try {
    for (const calendar of repo.getSelectedCalendars(accountId)) {
      let pageToken: string | null = null;
      const events: UpsertGoogleCalendarEventInput[] = [];
      do {
        const page = await fetchPage(accessToken, {
          calendarId: calendar.googleCalendarId,
          timeMin: windowStart,
          timeMax: windowEnd,
          pageToken,
        });
        events.push(
          ...(page.items ?? [])
            .map((event) => normalizeCalendarEvent(event, calendar.googleCalendarId))
            .filter((event): event is UpsertGoogleCalendarEventInput => !!event),
        );
        pageToken = page.nextPageToken ?? null;
      } while (pageToken);

      repo.replaceEventsForCalendarWindow({
        accountId,
        calendarLocalId: calendar.id,
        googleCalendarId: calendar.googleCalendarId,
        windowStart,
        windowEnd,
        events,
      });
    }
  } catch (error) {
    const nextStatus = statusForSyncError(error);
    repo.updateAccountStatus(accountId, nextStatus, messageForError(error, 'Event sync failed'));
    captureGoogleCalendarException(error, 'event_window_sync', {
      google_calendar_http_status: googleApiStatusTag(error),
      google_calendar_account_status: nextStatus,
    });
    throw error;
  }

  repo.markAccountSynced(accountId, now.toISOString());
}
