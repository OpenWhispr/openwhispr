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

export async function clearGoogleToken(token: string): Promise<void> {
  await native?.clearToken(token);
}
