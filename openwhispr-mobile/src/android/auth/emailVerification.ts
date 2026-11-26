import type { AuthUser } from '@/android/lib/authClient';

/** Checked like desktop's EmailVerificationStep: every 5 s while the verify screen is open. */
export const VERIFY_POLL_MS = 5000;

/**
 * A real account signed in with a password that hasn't verified its email yet. Decision 12: it
 * verifies before going on. Google and Microsoft accounts arrive verified and never see this.
 */
export function needsEmailVerification(user: AuthUser | null | undefined): boolean {
  return !!user && !user.isAnonymous && !user.emailVerified;
}

/** The API's own answer for the signed-in account; null when it couldn't be asked. */
export async function readVerified(): Promise<boolean | null> {
  try {
    // Loaded here so the sign-in screens don't pull the API client in just to render.
    const { api } = require('@/android/lib/apiClient') as typeof import('@/android/lib/apiClient');
    const result = await api.get<{ verified?: boolean }>('/api/auth/verification-status');
    return result?.verified === true;
  } catch {
    return null;
  }
}

export type VerifyLinkOutcome = 'verified' | 'invalid' | 'network';

/**
 * Verifies the token from the email's link (openwhispr.com/android-verify-email?token=…) through
 * the API's POST /api/auth/verify-email, as the website does. An expired, used or mistyped link
 * is 'invalid' (6.6); an account already verified counts as verified.
 */
export async function verifyEmailToken(token: string): Promise<VerifyLinkOutcome> {
  const { BASE_URL, getClientVersionHeader } =
    require('@/android/lib/apiClient') as typeof import('@/android/lib/apiClient');
  const { sessionFetch } =
    require('@/android/lib/sessionFetch') as typeof import('@/android/lib/sessionFetch');
  try {
    // Without the app's session, and with cookies omitted both ways: the API signs the link's
    // account in when the caller isn't it, which would silently switch a phone signed in as
    // someone else. VerifyLinkScreen marks the app's own account verified, and only when the
    // link is for that account.
    const response = await sessionFetch(`${BASE_URL}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getClientVersionHeader() },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return 'verified';
    return response.status >= 400 && response.status < 500 && response.status !== 429
      ? 'invalid'
      : 'network';
  } catch {
    return 'network';
  }
}

/** The address a verify link is for, read from its token (a JWT; no secret needed to read it). */
export function tokenEmail(token: string | undefined): string | null {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(
      globalThis.atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')),
    );
    return typeof json?.email === 'string' ? json.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
