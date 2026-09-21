import { createAuthClient } from 'better-auth/client';
import { anonymousClient } from 'better-auth/client/plugins';
import { expoClient } from '@better-auth/expo/client';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { fetch } from 'expo/fetch';
import { getClientVersionHeader } from './apiClient';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com';
// Mirrors ANONYMOUS_EMAIL_DOMAIN in the API's lib/anonymous-identity.ts.
const ANONYMOUS_EMAIL_DOMAIN = 'anon.openwhispr.invalid';
const COOKIE_STORAGE_KEY = 'openwhispr_cookie';
const SESSION_DATA_STORAGE_KEY = 'openwhispr_session_data';
const PRODUCTION_BUNDLE_ID = 'com.gizmolabs.openwhispr';

function firstScheme(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveAuthScheme(): string {
  const explicitScheme = process.env.EXPO_PUBLIC_OPENWHISPR_SCHEME;
  if (explicitScheme) return explicitScheme;

  const openWhisprConfig = Constants.expoConfig?.extra?.openWhispr as
    | { scheme?: string }
    | undefined;
  const configuredScheme = openWhisprConfig?.scheme || firstScheme(Constants.expoConfig?.scheme);
  const nativeBundleId = Application.applicationId;

  if (nativeBundleId && nativeBundleId !== PRODUCTION_BUNDLE_ID) {
    return configuredScheme && configuredScheme !== 'openwhispr'
      ? configuredScheme
      : 'openwhispr-dev';
  }

  return configuredScheme || 'openwhispr';
}

const client = createAuthClient({
  baseURL: API_URL,
  plugins: [
    anonymousClient(),
    expoClient({
      scheme: resolveAuthScheme(),
      storagePrefix: 'openwhispr',
      storage: SecureStore,
    }),
  ],
});

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  /**
   * True while the user is an onboarding session that has not created an
   * account yet. The id of such a user is replaced when they sign up, so
   * anything keyed on user id has to treat the transition as a link rather
   * than an account switch — see sync.user_was_anonymous in syncEngine.
   */
  isAnonymous: boolean;
}

export interface AuthResult {
  user: AuthUser | null;
  sessionCookie: string | null;
  error: string | null;
}

export interface AnonymousAuthResult extends AuthResult {
  /** HTTP status of a refusal the server sent; null when no response arrived. */
  status: number | null;
}

export interface SocialAuthResult {
  success: boolean;
  sessionCookie: string | null;
  error: string | null;
}

function isAnonymousEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${ANONYMOUS_EMAIL_DOMAIN}`);
}

type RawUser = {
  id?: string;
  email?: string;
  name?: string | null;
  emailVerified?: boolean;
  isAnonymous?: boolean | null;
};

function mapUser(raw: RawUser | null | undefined): AuthUser | null {
  if (!raw?.id || !raw.email) return null;
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name ?? undefined,
    emailVerified: raw.emailVerified ?? false,
    // Falls back to the address because both directions of a wrong answer are
    // damaging — a real user read as anonymous never escapes the account step,
    // an anonymous one read as real loses their notes to the sync wipe. The
    // placeholder domain is a second, independent signal if the plugin field
    // ever fails to survive serialisation.
    isAnonymous: raw.isAnonymous ?? isAnonymousEmail(raw.email),
  };
}

function currentCookie(): string | null {
  return client.getCookie() || null;
}

export async function getStoredSession(): Promise<string | null> {
  return currentCookie();
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(COOKIE_STORAGE_KEY).catch(() => undefined),
    SecureStore.deleteItemAsync(SESSION_DATA_STORAGE_KEY).catch(() => undefined),
  ]);
}

export async function getSession(): Promise<AuthUser | null> {
  const { data } = await client.getSession();
  return mapUser(data?.user);
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await client.signIn.email({ email, password });
  if (error) {
    return { user: null, sessionCookie: null, error: error.message ?? 'Sign in failed' };
  }
  return { user: mapUser(data?.user), sessionCookie: currentCookie(), error: null };
}

export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string,
): Promise<AuthResult> {
  const { data, error } = await client.signUp.email({
    email,
    password,
    name: name || email.split('@')[0],
  });
  if (error) {
    return { user: null, sessionCookie: null, error: error.message ?? 'Sign up failed' };
  }
  return { user: mapUser(data?.user), sessionCookie: currentCookie(), error: null };
}

/**
 * Opens a server session for a user who has not signed up yet, so onboarding
 * can exercise the real product — cloud transcription, usage limits, the
 * paywall — without an account. The session survives signup: linking migrates
 * the anonymous user's billing identity onto the new account.
 */
export async function signInAnonymously(): Promise<AnonymousAuthResult> {
  const { data, error } = await client.signIn.anonymous();
  if (error) {
    return {
      user: null,
      sessionCookie: null,
      error: error.message ?? 'Anonymous sign in failed',
      status: error.status || null,
    };
  }
  return { user: mapUser(data?.user), sessionCookie: currentCookie(), error: null, status: null };
}

export async function signOut(): Promise<void> {
  try {
    await client.signOut();
  } catch {
    /* empty */
  }
}

export function signInWithGoogle(): Promise<SocialAuthResult> {
  return socialSignIn('google');
}

export function signInWithApple(): Promise<SocialAuthResult> {
  return socialSignIn('apple');
}

export function signInWithMicrosoft(): Promise<SocialAuthResult> {
  return socialSignIn('microsoft');
}

async function socialSignIn(provider: 'google' | 'apple' | 'microsoft'): Promise<SocialAuthResult> {
  const { error } = await client.signIn.social({ provider, callbackURL: '/' });
  if (error) {
    return { success: false, sessionCookie: null, error: error.message ?? 'OAuth failed' };
  }
  return { success: true, sessionCookie: currentCookie(), error: null };
}

export async function deleteAccount(): Promise<void> {
  const cookie = currentCookie();
  if (!cookie) {
    throw new Error('Not authenticated');
  }
  const res = await fetch(`${API_URL}/api/auth/delete-account`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...getClientVersionHeader() },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(data.error || data.message || 'Failed to delete account');
  }
}

export async function initAuthenticatedUser(
  user: AuthUser | null,
  fallbackName?: string,
): Promise<void> {
  if (!user?.id || !user.email) return;
  try {
    await fetch(`${API_URL}/api/auth/init-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        email: user.email,
        name: user.name || fallbackName || user.email.split('@')[0],
      }),
    });
  } catch {
    /* empty */
  }
}

export async function checkUserExists(email: string): Promise<'signin' | 'signup'> {
  try {
    const res = await fetch(`${API_URL}/api/check-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return 'signup';
    const data = (await res.json()) as { exists?: boolean };
    return data.exists ? 'signin' : 'signup';
  } catch {
    return 'signup';
  }
}
