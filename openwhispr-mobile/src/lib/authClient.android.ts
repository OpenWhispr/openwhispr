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
} from './authClientCore';
export type { AuthUser, AuthResult, AnonymousAuthResult, SocialAuthResult } from './authClientCore';

const client = createNativeAuthClient({
  fetchOptions: {
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
  signInWithGoogle,
  signInWithApple,
  signInWithMicrosoft,
  deleteAccount,
  initAuthenticatedUser,
  checkUserExists,
} = createAuthApi(client, { fetch: sessionFetch, afterSignIn: cacheAndroidSessionAfterSignIn });
