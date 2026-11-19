import { chooseGoogleAccount } from '../../../modules/android-google-authorization/src';
import { calendarRepository } from '@/data/calendarRepository';
import type { CalendarRepository, GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  authorizeGoogleCalendarTokens,
  GoogleCalendarAuthError,
  saveGoogleCalendarTokens,
  type GoogleCalendarAuthorizationResult,
  type GoogleIdentityClaims,
} from '@/services/calendar/googleCalendarAuth.android';
import {
  syncGoogleCalendarList,
  syncSelectedGoogleCalendarEventWindow,
} from '@/services/calendar/googleCalendarSync';
import { captureGoogleCalendarException } from '@/services/calendar/googleCalendarTelemetry';

const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

async function fetchIdentity(
  accessToken: string,
  httpClient: typeof fetch,
): Promise<GoogleIdentityClaims> {
  const res = await httpClient(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  };
  if (!res.ok || typeof json.sub !== 'string' || json.sub.length === 0) {
    throw new GoogleCalendarAuthError(
      'missing_subject',
      `Google account lookup failed with HTTP ${res.status}`,
    );
  }
  return {
    sub: json.sub,
    email: typeof json.email === 'string' ? json.email : undefined,
    name: typeof json.name === 'string' ? json.name : undefined,
  };
}

/**
 * Connect: Android's account picker (Play services alone would silently reuse the account it
 * granted last, so "Add another Google account" could never pick a new one), Google's consent
 * sheet for that account, then who the account is.
 */
export async function authorizeGoogleCalendarOnAndroid(
  httpClient: typeof fetch = globalThis.fetch,
): Promise<GoogleCalendarAuthorizationResult> {
  let account: string | null;
  try {
    account = await chooseGoogleAccount();
  } catch (error) {
    throw new GoogleCalendarAuthError(
      'authorization_failed',
      error instanceof Error ? error.message : 'Could not open the account picker',
    );
  }
  if (!account) throw new GoogleCalendarAuthError('cancelled', 'No Google account was chosen');
  const tokens = await authorizeGoogleCalendarTokens({ account, interactive: true });
  const identity = await fetchIdentity(tokens.accessToken, httpClient);
  return { tokens, identity };
}

/** Saves an account Play services authorized and runs its first sync, like iOS's connect. */
export async function saveAuthorizedGoogleCalendarAccount(
  { identity, tokens }: GoogleCalendarAuthorizationResult,
  repo: CalendarRepository = calendarRepository,
): Promise<GoogleCalendarAccount> {
  try {
    const account = repo.upsertAccount({
      googleSubject: identity.sub,
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      grantedScopes: tokens.scopes.join(' '),
      status: 'connected',
      lastError: null,
    });
    await saveGoogleCalendarTokens(identity.sub, tokens);
    await syncGoogleCalendarList(account.id, { repo });
    await syncSelectedGoogleCalendarEventWindow(account.id, { repo });
    return repo.getAccountById(account.id) ?? account;
  } catch (error) {
    captureGoogleCalendarException(error, 'connect');
    throw error;
  }
}
