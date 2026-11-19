import {
  authorizeGoogle,
  clearGoogleToken,
  type GoogleAuthorizationErrorCode,
} from '../../../modules/google-authorization/src';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  GoogleCalendarAuthError,
  hasRequiredGoogleCalendarScopes,
  saveGoogleCalendarTokens,
  type GoogleCalendarAuthorizationResult,
  type GoogleCalendarTokenBundle,
  type GoogleIdentityClaims,
} from './googleCalendarAuth';
import { getGoogleCalendarRequestScopes } from './googleCalendarConfig';

/**
 * Android signs in through Play services' AuthorizationClient: Google refuses the custom-scheme
 * redirect the iOS flow uses. It hands back short-lived access tokens with no refresh token, and
 * asking again without UI returns a fresh one for as long as the grant stands.
 */

const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
// Play services doesn't say when a token expires; it reissues one before the hour runs out.
const ASSUMED_LIFETIME_MS = 50 * 60 * 1000;

const AUTH_ERROR_CODES: Record<GoogleAuthorizationErrorCode, string> = {
  CANCELLED: 'cancelled',
  CONSENT_REQUIRED: 'consent_required',
  FAILED: 'authorization_failed',
};

function toAuthError(error: unknown): GoogleCalendarAuthError {
  if (error instanceof GoogleCalendarAuthError) return error;
  const nativeCode = (error as { code?: string } | null)?.code as
    | GoogleAuthorizationErrorCode
    | undefined;
  const message = error instanceof Error ? error.message : 'Google authorization failed';
  return new GoogleCalendarAuthError(
    (nativeCode && AUTH_ERROR_CODES[nativeCode]) || 'authorization_failed',
    message,
  );
}

async function authorizeTokens(options: {
  account?: string | null;
  interactive: boolean;
}): Promise<GoogleCalendarTokenBundle> {
  let granted;
  try {
    granted = await authorizeGoogle(getGoogleCalendarRequestScopes(), options);
  } catch (error) {
    throw toAuthError(error);
  }
  if (!granted.accessToken) {
    throw new GoogleCalendarAuthError(
      'missing_access_token',
      'Google authorization did not include an access token',
    );
  }
  if (!hasRequiredGoogleCalendarScopes(granted.grantedScopes)) {
    throw new GoogleCalendarAuthError(
      'missing_required_scopes',
      'Google Calendar access was not granted',
    );
  }
  return {
    accessToken: granted.accessToken,
    refreshToken: null,
    idToken: null,
    expiresAt: Date.now() + ASSUMED_LIFETIME_MS,
    scopes: granted.grantedScopes,
  };
}

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

/** Connect: Google's account and consent sheet, then who the account is. */
export async function authorizeGoogleCalendarOnAndroid(
  httpClient: typeof fetch = globalThis.fetch,
): Promise<GoogleCalendarAuthorizationResult> {
  const tokens = await authorizeTokens({ interactive: true });
  const identity = await fetchIdentity(tokens.accessToken, httpClient);
  return { tokens, identity };
}

/** A fresh access token for a connected account, without UI; a lost grant needs a reconnect. */
export async function getAndroidGoogleCalendarAccessToken(
  account: GoogleCalendarAccount,
): Promise<string> {
  const tokens = await authorizeTokens({ account: account.email, interactive: false });
  await saveGoogleCalendarTokens(account.googleSubject, tokens);
  return tokens.accessToken;
}

/** After a revoke, so Play services doesn't hand the dead token back. */
export async function forgetAndroidGoogleCalendarToken(token: string): Promise<void> {
  await clearGoogleToken(token).catch(() => undefined);
}
