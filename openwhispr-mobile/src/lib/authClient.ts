import * as SecureStore from 'expo-secure-store';
import { storageAdapter } from '@better-auth/expo/client';
import { Platform } from 'react-native';
import {
  SESSION_DATA_STORAGE_KEY,
  createAuthApi,
  createNativeAuthClient,
  mapAuthUser,
  type AuthUser,
} from './authClientCore';
export type { AuthUser, AuthResult, AnonymousAuthResult, SocialAuthResult } from './authClientCore';

const client = createNativeAuthClient({
  // Recorded by the API as the origin of an account created here, including
  // through the browser OAuth flow, which carries them in its server-held state.
  fetchOptions: { headers: { 'x-openwhispr-source': 'mobile', 'x-openwhispr-os': Platform.OS } },
});

export const {
  getStoredSession,
  clearSession,
  getSession,
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
} = createAuthApi(client);

export interface CachedSession {
  user: AuthUser;
  sessionCookie: string;
}

type CachedRawUser = Parameters<typeof mapAuthUser>[0];

/** Local capture attribution only; API requests still require the restored auth store. */
export async function getCachedSession(): Promise<CachedSession | null> {
  try {
    // Read the SDK's chunked local cache directly: its session atom hydrates asynchronously
    // as part of getSession(), which also makes a network request we must not wait for.
    const [raw, sessionCookie, guest] = await Promise.all([
      storageAdapter(SecureStore).getItemAsync(SESSION_DATA_STORAGE_KEY),
      client.getCookie(),
      SecureStore.getItemAsync('openwhispr_guest_session'),
    ]);
    if (guest === 'true') return null;
    const cached = (raw ? JSON.parse(raw) : null) as {
      user?: CachedRawUser;
      session?: { id?: string; userId?: string; token?: string; expiresAt?: string | Date };
    } | null;
    const user = mapAuthUser(cached?.user);
    const session = cached?.session;
    const expiresAt = session?.expiresAt ? new Date(session.expiresAt).getTime() : NaN;
    if (
      !user ||
      !session?.id ||
      session.userId !== user.id ||
      !session.token ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      return null;
    const signedToken = sessionCookie.match(
      /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/,
    )?.[1];
    // A sign-in can replace the cookie before the SDK refreshes its cached user.
    if (!signedToken || !decodeURIComponent(signedToken).startsWith(`${session.token}.`)) {
      return null;
    }
    return { user, sessionCookie };
  } catch {
    return null;
  }
}
