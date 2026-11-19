import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { storageAdapter } from '@better-auth/expo/client';
import { sessionFetch } from './sessionFetch.android';
import {
  COOKIE_STORAGE_KEY,
  SESSION_DATA_STORAGE_KEY,
  createAuthApi,
  createNativeAuthClient,
  mapAuthUser,
  type AuthUser,
  type SocialAuthResult,
} from './authClientCore';
import {
  isGoogleSignInAvailable,
  signInWithGoogleSheet,
} from '../../modules/android-google-authorization/src';
export type { AuthUser, AuthResult, AnonymousAuthResult, SocialAuthResult } from './authClientCore';

const client = createNativeAuthClient({
  fetchOptions: {
    // Recorded by the API as the origin of an account created here, including
    // through the browser OAuth flow, which carries them in its server-held state.
    headers: { 'x-openwhispr-source': 'mobile', 'x-openwhispr-os': 'android' },
    onResponse({ request, response }) {
      // A captive portal or preview gateway can redirect get-session to 200
      // HTML. Reject it before Expo's onSuccess replaces the cached session;
      // it is a transport outage, not an authoritative signed-out response.
      if (
        new URL(request.url).pathname.endsWith('/get-session') &&
        response.ok &&
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
          'application/json'
      ) {
        throw new TypeError('Session endpoint returned an unexpected response type');
      }
    },
  },
  cookiePrefix: ['openwhispr', 'better-auth'],
});

function clearStoredAuthValue(key: string): Promise<void> {
  // The adapter waits for pending SDK writes and clears the stored chunks.
  return storageAdapter(SecureStore)
    .setItemAsync(key, '{}')
    .catch(() => undefined);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    clearStoredAuthValue(COOKIE_STORAGE_KEY),
    clearStoredAuthValue(SESSION_DATA_STORAGE_KEY),
  ]);
}

function isTransientSessionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? error.status : undefined;
  if (typeof status === 'number') return status === 0 || status >= 500;
  return (
    error instanceof TypeError ||
    ('name' in error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

async function getCachedAndroidUser(): Promise<AuthUser | null> {
  // Expo already stores this server-issued session in SecureStore. Use it only
  // for startup identity during a transport outage, never as paid-access proof.
  try {
    const cookie = await getStoredSession();
    if (!cookie) return null;
    // Use Expo's adapter because larger sessions are split across secure-store keys.
    const raw = await storageAdapter(SecureStore).getItemAsync(SESSION_DATA_STORAGE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (typeof cached?.user?.id !== 'string' || typeof cached.user.email !== 'string') return null;
    const user = mapAuthUser(cached?.user);
    const session = cached?.session;
    if (
      !user ||
      typeof session?.id !== 'string' ||
      !session.id ||
      session.userId !== user.id ||
      typeof session.token !== 'string' ||
      !session.token ||
      typeof session.expiresAt !== 'string' ||
      !(new Date(session.expiresAt).getTime() > Date.now())
    ) {
      return null;
    }
    // Production names its session cookie openwhispr; retain the SDK default for previews.
    const tokens = cookie
      .split(';')
      .map((part) => part.trim())
      .filter((part) => /^(?:__Secure-)?(?:openwhispr|better-auth)\.session_token=/.test(part))
      .map((part) => decodeURIComponent(part.slice(part.indexOf('=') + 1)).split('.')[0]);
    // A stale cache from another login must never select the wrong local workspace.
    return cookie === (await getStoredSession()) &&
      tokens.length === 1 &&
      tokens[0] === session.token
      ? user
      : null;
  } catch {
    return null;
  }
}

export async function getSession(
  options: { allowOfflineCache?: boolean } = {},
): Promise<AuthUser | null> {
  const allowCache = options.allowOfflineCache === true;
  try {
    const { data, error } = await client.getSession();
    if (allowCache && error && isTransientSessionFailure(error)) return getCachedAndroidUser();
    const user = mapAuthUser(data?.user);
    if (allowCache && !user && (!error || error.status === 401 || error.status === 403)) {
      await clearStoredAuthValue(SESSION_DATA_STORAGE_KEY);
    }
    return user;
  } catch (error) {
    if (allowCache && isTransientSessionFailure(error)) return getCachedAndroidUser();
    if (
      allowCache &&
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error.status === 401 || error.status === 403)
    ) {
      await clearStoredAuthValue(SESSION_DATA_STORAGE_KEY);
    }
    throw error;
  }
}

async function cacheAndroidSessionAfterSignIn(
  data: { user?: unknown; token?: string | null } | null,
): Promise<void> {
  if (!data?.user || !data.token) return;
  // Auth routes supply a user/token, but Expo only caches the complete
  // server-issued session on get-session. Warm it while online so a later
  // restart during a transport outage can recover the matching workspace.
  // Signup without auto-sign-in has no token and must not warm another session.
  // Failure here must not turn successful authentication into a failure;
  // startup still rejects absent, expired or cookie-mismatched cached sessions.
  await client.getSession({ fetchOptions: { timeout: 5000 } }).catch(() => undefined);
}

export const {
  getStoredSession,
  signInWithEmail,
  signUpWithEmail,
  signInAnonymously,
  signOut,
  signInWithGoogle: signInWithGoogleInBrowser,
  signInWithApple,
  signInWithMicrosoft,
  deleteAccount,
  initAuthenticatedUser,
  checkUserExists,
} = createAuthApi(client, { fetch: sessionFetch, afterSignIn: cacheAndroidSessionAfterSignIn });

export type PasswordResetResponse = {
  status: number | null;
  code?: string;
  retryAfter?: string | null;
};

// The raw answers of Better Auth's two reset endpoints; src/android/auth/passwordReset.ts reads them.
export async function requestPasswordResetEmail(
  email: string,
  redirectTo: string,
): Promise<PasswordResetResponse> {
  let retryAfter: string | null = null;
  const { error } = await client.requestPasswordReset({
    email,
    redirectTo,
    fetchOptions: {
      timeout: 15_000,
      onError: ({ response }) => {
        retryAfter = response.headers.get('X-Retry-After');
      },
    },
  });
  if (!error) return { status: 200 };
  return { status: error.status || null, code: error.code, retryAfter };
}

export async function resetPasswordWithToken(
  newPassword: string,
  token: string,
): Promise<PasswordResetResponse> {
  const { error } = await client.resetPassword({
    newPassword,
    token,
    fetchOptions: { timeout: 15_000 },
  });
  if (!error) return { status: 200 };
  return { status: error.status || null, code: error.code };
}

// The API's Google web client (Cloud project openwhispr-desktop). Android's sheet issues the ID
// token for it, so the API verifies it as it does a browser sign-in; the project's Android clients
// tie the sheet to this app's package and signing key. Public, like any OAuth client id.
const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_AUTH_WEB_CLIENT_ID ||
  '296701228479-22st3am22trhukoo8gi0npfgq2c5oco4.apps.googleusercontent.com';

function isCancelled(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'CANCELLED';
}

/**
 * Google sign-in through Android's "Sign in with Google" sheet (1.8), then Better Auth's ID-token
 * sign-in. A build without the sheet, or a sheet that fails, falls back to the browser flow.
 * Backing out of the sheet is not an error and says nothing.
 */
export async function signInWithGoogle(): Promise<SocialAuthResult> {
  if (!isGoogleSignInAvailable()) return signInWithGoogleInBrowser();
  const nonce = Crypto.randomUUID();
  let idToken: string;
  try {
    ({ idToken } = await signInWithGoogleSheet(GOOGLE_WEB_CLIENT_ID, nonce));
  } catch (error) {
    if (isCancelled(error)) return { success: false, sessionCookie: null, error: null };
    console.warn('[auth] Google sheet failed, using the browser:', error);
    return signInWithGoogleInBrowser();
  }
  const { data, error } = await client.signIn.social({
    provider: 'google',
    idToken: { token: idToken, nonce },
    callbackURL: '/',
    fetchOptions: { timeout: 15_000 },
  });
  if (error) {
    return { success: false, sessionCookie: null, error: error.message ?? 'Google sign-in failed' };
  }
  await cacheAndroidSessionAfterSignIn(data as { user?: unknown; token?: string | null });
  return { success: true, sessionCookie: (await getStoredSession()) ?? null, error: null };
}
