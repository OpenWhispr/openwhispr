import type { PasswordResetResponse } from '@/lib/authClient.android';

/**
 * The reset email links here. Android opens the app on it as an App Link once openwhispr.com
 * serves assetlinks.json; without the app the website forwards it to its own /reset-password.
 * A path of its own, so reset links asked for on a computer keep opening the website.
 */
export const RESET_REDIRECT_URL = 'https://openwhispr.com/android-reset-password';

/** Better Auth refuses a second email inside this window; the pill counts it down. */
export const RESEND_SECONDS = 60;
/** Used when a 429 names no wait. */
const RATE_LIMIT_FALLBACK_SECONDS = 300;
export const MIN_PASSWORD_LENGTH = 8;

export type ResetRequestOutcome =
  | { kind: 'sent' }
  | { kind: 'rateLimited'; waitSeconds: number }
  | { kind: 'network' }
  | { kind: 'failed' };

export type ResetPasswordOutcome =
  | { kind: 'saved' }
  | { kind: 'invalidToken' }
  | { kind: 'tooShort' }
  | { kind: 'rateLimited' }
  | { kind: 'network' }
  | { kind: 'failed' };

/** Enough to catch a typo before sending; the server decides the rest. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(value.trim());
}

export function readRequestOutcome(response: PasswordResetResponse): ResetRequestOutcome {
  if (response.status === 200) return { kind: 'sent' };
  if (response.status === 429) {
    const wait = Number(response.retryAfter);
    return {
      kind: 'rateLimited',
      waitSeconds:
        Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : RATE_LIMIT_FALLBACK_SECONDS,
    };
  }
  if (response.status === null || response.status === 0 || response.status >= 500)
    return { kind: 'network' };
  return { kind: 'failed' };
}

export function readResetOutcome(response: PasswordResetResponse): ResetPasswordOutcome {
  if (response.status === 200) return { kind: 'saved' };
  if (response.code === 'INVALID_TOKEN') return { kind: 'invalidToken' };
  if (response.code === 'PASSWORD_TOO_SHORT') return { kind: 'tooShort' };
  if (response.status === 429) return { kind: 'rateLimited' };
  if (response.status === null || response.status === 0 || response.status >= 500)
    return { kind: 'network' };
  return { kind: 'failed' };
}

/** "0:42", "4:59". */
export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The email this phone last asked a reset link for, so the link's screen can name it and sign
// in with the new password. Kept no longer than the link lives.
const PENDING_KEY = 'android-password-reset';
const LINK_LIFETIME_MS = 60 * 60 * 1000;

export function rememberResetEmail(email: string, now = Date.now()): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email, at: now }));
  } catch {
    /* only a convenience */
  }
}

export function pendingResetEmail(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { email?: unknown; at?: unknown };
    if (typeof value.email !== 'string' || typeof value.at !== 'number') return null;
    return now - value.at <= LINK_LIFETIME_MS ? value.email : null;
  } catch {
    return null;
  }
}

export function forgetResetEmail(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* only a convenience */
  }
}
