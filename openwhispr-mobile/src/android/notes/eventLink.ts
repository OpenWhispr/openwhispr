import type { GoogleCalendarAccount, GoogleCalendarEvent } from '@/data/calendarTypes';
import {
  hasRequiredGoogleCalendarScopes,
  refreshStoredGoogleCalendarToken,
} from '@/services/calendar/googleCalendarAuth';
import { getGoogleCalendarClientId } from '@/services/calendar/googleCalendarConfig';

type ConferenceFields = {
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
};

/** Links already read this run of the app, by event: a Meet link doesn't change mid-meeting. */
const cache = new Map<string, string | null>();

/**
 * N7's Join for a meeting whose link isn't in its description or location: Google keeps a Meet
 * link in `hangoutLink` / `conferenceData`, which the calendar sync doesn't store, so the event
 * sheet reads those two fields for the one event it shows. Any failure means no Join.
 */
export async function fetchConferenceLink(
  event: GoogleCalendarEvent,
  account: GoogleCalendarAccount | null,
  httpClient: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const key = `${event.accountId}:${event.googleCalendarId}:${event.googleEventId}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const clientId = getGoogleCalendarClientId();
  if (!account || !clientId || !hasRequiredGoogleCalendarScopes(account.grantedScopes)) return null;
  try {
    const { accessToken } = await refreshStoredGoogleCalendarToken({
      clientId,
      googleSubject: account.googleSubject,
    });
    const url =
      'https://www.googleapis.com/calendar/v3/calendars/' +
      `${encodeURIComponent(event.googleCalendarId)}/events/` +
      `${encodeURIComponent(event.googleEventId)}` +
      '?fields=hangoutLink,conferenceData(entryPoints(entryPointType,uri))';
    const response = await httpClient(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return null;
    const body = (await response.json()) as ConferenceFields;
    const link =
      body.hangoutLink?.trim() ||
      body.conferenceData?.entryPoints
        ?.find((entry) => entry.entryPointType === 'video' && entry.uri?.trim())
        ?.uri?.trim() ||
      null;
    const safe = link && /^https:\/\//i.test(link) ? link : null;
    cache.set(key, safe);
    return safe;
  } catch {
    return null;
  }
}
