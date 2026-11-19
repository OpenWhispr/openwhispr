import type { AuthUser } from '@/lib/authClient';

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
    const { api } = require('@/lib/apiClient') as typeof import('@/lib/apiClient');
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
  const { api, ApiError } = require('@/lib/apiClient') as typeof import('@/lib/apiClient');
  try {
    await api.post('/api/auth/verify-email', { token });
    return 'verified';
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    )
      return 'invalid';
    return 'network';
  }
}
