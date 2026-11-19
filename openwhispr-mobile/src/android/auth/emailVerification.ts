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
