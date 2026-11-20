import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface GoogleAuthorization {
  accessToken: string | null;
  grantedScopes: string[];
}

/** Error codes the native module rejects with. */
export type GoogleAuthorizationErrorCode = 'CANCELLED' | 'CONSENT_REQUIRED' | 'FAILED';

interface NativeGoogleAuthorization {
  authorize(
    scopes: string[],
    account: string | null,
    interactive: boolean,
  ): Promise<GoogleAuthorization>;
  clearToken(token: string): Promise<void>;
  chooseAccount(): Promise<string | null>;
  /** Missing on builds before Google sign-in moved to Android's sheet. */
  signIn?(serverClientId: string, nonce: string): Promise<{ idToken: string; email: string }>;
}

const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<NativeGoogleAuthorization>('GoogleAuthorization')
    : null;

export function isGoogleAuthorizationAvailable(): boolean {
  return native != null;
}

/**
 * Asks Play services for an access token for `scopes`. Interactive shows Google's account and
 * consent sheet when needed; otherwise a missing grant rejects with CONSENT_REQUIRED.
 */
export function authorizeGoogle(
  scopes: string[],
  options: { account?: string | null; interactive: boolean },
): Promise<GoogleAuthorization> {
  if (!native) return Promise.reject(new Error('Google authorization is unavailable'));
  return native.authorize(scopes, options.account ?? null, options.interactive);
}

/** Android's Google account picker; null when the user backs out. */
export function chooseGoogleAccount(): Promise<string | null> {
  if (!native) return Promise.reject(new Error('Google authorization is unavailable'));
  return native.chooseAccount();
}

export async function clearGoogleToken(token: string): Promise<void> {
  await native?.clearToken(token);
}

/** True when this build has Android's "Sign in with Google" sheet. */
export function isGoogleSignInAvailable(): boolean {
  return typeof native?.signIn === 'function';
}

/**
 * Android's "Sign in with Google" sheet. Resolves an ID token for `serverClientId` that carries
 * `nonce`; rejects with code CANCELLED when the user backs out.
 */
export function signInWithGoogleSheet(
  serverClientId: string,
  nonce: string,
): Promise<{ idToken: string; email: string }> {
  if (!native?.signIn) return Promise.reject(new Error('Google sign-in is unavailable'));
  return native.signIn(serverClientId, nonce);
}
