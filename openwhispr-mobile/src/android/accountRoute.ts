/**
 * Root rebuilds the navigator whenever the account changes (sign-in, sign-up, sign-out), so no
 * screen keeps showing the previous account's data. A rebuilt navigator starts at the root,
 * which loses the screen the person was on. These screens hold nothing from either account, so
 * the app reopens them: Settings after signing out there, Verify your email after a sign-up,
 * Password updated after a reset signs in. Anything else (a note, a recording) stays closed.
 */
const SAFE_ROUTES = new Set([
  '(account)', // Settings
  'auth',
  'android-reset-password',
  'android-verify-email',
]);

export type RestoredRoute = { pathname: string; params: Record<string, string> };

export function routeToRestore(
  segments: readonly string[],
  params: Record<string, string | string[] | undefined>,
): RestoredRoute | null {
  if (segments.length !== 1 || !SAFE_ROUTES.has(segments[0])) return null;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') kept[key] = value;
  }
  return { pathname: `/${segments[0]}`, params: kept };
}
