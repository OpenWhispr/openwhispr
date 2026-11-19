import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

// Only the calendar scopes gate the integration. openid/email are requested for the account
// subject/email, but Google echoes them back in canonical URL form (email ->
// .../userinfo.email), so they can't be matched verbatim and must not be treated as required.
export const GOOGLE_CALENDAR_REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

export const GOOGLE_AUTH_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

type OpenWhisprExtra = {
  scheme?: string;
  googleCalendar?: {
    iosClientId?: string;
    iosClientIdDev?: string;
    iosRedirectScheme?: string;
    iosRedirectUri?: string;
  };
};

const firstNonEmpty = (...values: Array<string | null | undefined>): string | undefined =>
  values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();

const firstScheme = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const deriveGoogleCalendarRedirectScheme = (clientId: string | null | undefined): string | null => {
  const suffix = '.apps.googleusercontent.com';
  const trimmed = clientId?.trim();
  if (!trimmed?.endsWith(suffix)) return null;
  return `com.googleusercontent.apps.${trimmed.slice(0, -suffix.length)}`;
};

/**
 * Android signs in with its own Google OAuth client (an Android client for the app's package,
 * redirecting to `<package>:/oauth2redirect`). Without one the build has no calendar connect.
 */
function androidClientId(): string | null {
  return (
    firstNonEmpty(
      process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ANDROID_CLIENT_ID,
      process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ANDROID_CLIENT_ID_DEV,
    ) ?? null
  );
}

function androidRedirectUri(): string {
  const configured = firstNonEmpty(process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ANDROID_REDIRECT_URI);
  if (configured) return configured;
  const pkg = Constants.expoConfig?.android?.package ?? 'com.gizmolabs.openwhispr';
  return `${pkg}:/oauth2redirect`;
}

export function getGoogleCalendarClientId(): string | null {
  if (Platform.OS === 'android') return androidClientId();
  const openWhispr = Constants.expoConfig?.extra?.openWhispr as OpenWhisprExtra | undefined;
  return (
    firstNonEmpty(
      openWhispr?.googleCalendar?.iosClientId,
      process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID,
      process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_CLIENT_ID_DEV,
      openWhispr?.googleCalendar?.iosClientIdDev,
    ) ?? null
  );
}

export function getGoogleCalendarRedirectUri(): string {
  if (Platform.OS === 'android') return androidRedirectUri();
  const openWhispr = Constants.expoConfig?.extra?.openWhispr as OpenWhisprExtra | undefined;
  const configuredRedirectUri = firstNonEmpty(
    openWhispr?.googleCalendar?.iosRedirectUri,
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI,
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI_DEV,
  );
  if (configuredRedirectUri) return configuredRedirectUri;

  const googleRedirectScheme = firstNonEmpty(
    openWhispr?.googleCalendar?.iosRedirectScheme,
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_SCHEME,
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_SCHEME_DEV,
    deriveGoogleCalendarRedirectScheme(getGoogleCalendarClientId()),
  );
  if (googleRedirectScheme) return `${googleRedirectScheme}:/oauth2redirect`;

  const scheme = openWhispr?.scheme || firstScheme(Constants.expoConfig?.scheme) || 'openwhispr';
  return AuthSession.makeRedirectUri({ scheme, path: 'google-calendar/oauth' });
}

export function getGoogleCalendarRequestScopes(): string[] {
  return [...GOOGLE_CALENDAR_SCOPES];
}

export function getGoogleCalendarRequiredScopes(): string[] {
  return [...GOOGLE_CALENDAR_REQUIRED_SCOPES];
}
