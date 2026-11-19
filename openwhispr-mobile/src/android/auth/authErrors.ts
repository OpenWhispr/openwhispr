import type { AuthKey } from './strings';

export type SignInMethod = 'email' | 'google' | 'microsoft';

/**
 * Where a sign-in error shows. A wrong password or a short new password belongs under the
 * password field (1.5); everything else is the dark toast at the bottom (1.9). Messages come
 * from Better Auth and the auth store in English, so they are matched, not shown, when known.
 */
export type ErrorPlacement =
  | { place: 'password'; key: AuthKey }
  | { place: 'toast'; key: AuthKey }
  | { place: 'toast'; text: string };

export function placeAuthError(message: string): ErrorPlacement {
  const text = message.trim();
  if (/invalid (email or )?password|incorrect password|credential/i.test(text))
    return { place: 'password', key: 'wrongPassword' };
  if (/password (is )?too short|at least 8/i.test(text))
    return { place: 'password', key: 'passwordTooShort' };
  if (/already exists|already registered|already in use/i.test(text))
    return { place: 'toast', key: 'accountExists' };
  if (/network|connection|timed? ?out|fetch failed|failed to fetch/i.test(text))
    return { place: 'toast', key: 'networkError' };
  if (!text) return { place: 'toast', key: 'signInFailed' };
  return { place: 'toast', text };
}

// How each account on this phone last signed in, so "Sign in again" (2.5) can offer the
// password or the Google / Microsoft button (2.5b). Unknown (signed in before this build)
// falls back to the password, with "Use another account" for everything else.
const METHODS_KEY = 'android-sign-in-methods';

function readMethods(): Record<string, SignInMethod> {
  try {
    const value = JSON.parse(localStorage.getItem(METHODS_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? (value as Record<string, SignInMethod>) : {};
  } catch {
    return {};
  }
}

export function rememberSignInMethod(email: string, method: SignInMethod): void {
  try {
    localStorage.setItem(
      METHODS_KEY,
      JSON.stringify({ ...readMethods(), [email.trim().toLowerCase()]: method }),
    );
  } catch {
    /* only a convenience */
  }
}

export function lastSignInMethod(email: string): SignInMethod {
  const method = readMethods()[email.trim().toLowerCase()];
  return method === 'google' || method === 'microsoft' ? method : 'email';
}
