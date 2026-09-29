const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
type GoogleFetch = typeof globalThis.fetch;

export interface RawGoogleCalendarListEntry {
  id?: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  deleted?: boolean;
}

export interface RawGoogleCalendarListResponse {
  items?: RawGoogleCalendarListEntry[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface RawGoogleCalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  optional?: boolean;
  organizer?: boolean;
  resource?: boolean;
  self?: boolean;
}

export interface RawGoogleCalendarEvent {
  id?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  visibility?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string };
  attendees?: RawGoogleCalendarAttendee[];
  updated?: string;
  htmlLink?: string;
}

export interface RawGoogleCalendarEventsResponse {
  items?: RawGoogleCalendarEvent[];
  nextPageToken?: string;
}

interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class GoogleCalendarApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GoogleCalendarApiError';
    this.status = status;
  }
}

async function fetchGoogleJson<T>(
  path: string,
  accessToken: string,
  params: URLSearchParams,
  httpClient: GoogleFetch = globalThis.fetch,
): Promise<T> {
  const q = params.toString();
  const res = await httpClient(`${GOOGLE_CALENDAR_API_BASE}${path}${q ? `?${q}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as GoogleApiErrorBody | T;
  if (!res.ok) {
    const body = json as GoogleApiErrorBody;
    throw new GoogleCalendarApiError(
      body.error?.message || `Google Calendar request failed with HTTP ${res.status}`,
      res.status,
    );
  }
  return json as T;
}

export async function fetchGoogleCalendarListPage(
  accessToken: string,
  input: { pageToken?: string | null; syncToken?: string | null } = {},
  httpClient: GoogleFetch = globalThis.fetch,
): Promise<RawGoogleCalendarListResponse> {
  const params = new URLSearchParams();
  if (input.pageToken) params.set('pageToken', input.pageToken);
  else if (input.syncToken) params.set('syncToken', input.syncToken);
  return fetchGoogleJson<RawGoogleCalendarListResponse>(
    '/users/me/calendarList',
    accessToken,
    params,
    httpClient,
  );
}

export async function fetchGoogleCalendarEventsPage(
  accessToken: string,
  input: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    pageToken?: string | null;
  },
  httpClient: GoogleFetch = globalThis.fetch,
): Promise<RawGoogleCalendarEventsResponse> {
  const params = new URLSearchParams({
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (input.pageToken) params.set('pageToken', input.pageToken);
  return fetchGoogleJson<RawGoogleCalendarEventsResponse>(
    `/calendars/${encodeURIComponent(input.calendarId)}/events`,
    accessToken,
    params,
    httpClient,
  );
}
