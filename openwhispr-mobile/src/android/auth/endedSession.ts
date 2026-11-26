import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { AuthUser } from '@/android/lib/authClient';

/**
 * An account whose session the server ended (a password change, a sign-out elsewhere, an expiry).
 * Android keeps that account's workspace on screen (decision F4) and asks it to sign in again:
 * the "You've been signed out" sheet once (2.4), then Sign in again (2.5 / 2.5b).
 *
 * The account is remembered across launches, since the server's answer also clears the saved
 * session: without it the next launch would open the signed-out workspace and hide the notes.
 */
const ENDED_KEY = 'openwhispr_android_ended_session';

type Ended = { user: AuthUser; sheetShown: boolean };

export const useEndedSession = create<{
  /** The account that needs to sign in again, or null. */
  user: AuthUser | null;
  /** The 2.4 sheet is waiting to be shown for that account. */
  sheetPending: boolean;
}>(() => ({ user: null, sheetPending: false }));

function write(ended: Ended | null): Promise<void> {
  // A failed write only means the sheet may show again, or not survive a restart.
  return Promise.resolve()
    .then(() =>
      ended
        ? SecureStore.setItemAsync(ENDED_KEY, JSON.stringify(ended))
        : SecureStore.deleteItemAsync(ENDED_KEY),
    )
    .catch(() => undefined);
}

/** The account remembered by an earlier launch, read before the network. */
export async function readEndedSession(): Promise<AuthUser | null> {
  try {
    const raw = await SecureStore.getItemAsync(ENDED_KEY);
    if (!raw) return null;
    const ended = JSON.parse(raw) as Partial<Ended>;
    if (typeof ended?.user?.id !== 'string' || typeof ended.user.email !== 'string') return null;
    useEndedSession.setState({ user: ended.user, sheetPending: ended.sheetShown !== true });
    return ended.user;
  } catch {
    return null;
  }
}

/** The server ended this account's session: keep its workspace and ask it to sign in again. */
export function markSessionEnded(user: AuthUser): void {
  if (user.isAnonymous) return;
  const current = useEndedSession.getState();
  // The sheet shows once per ended session, not on every 401 that follows it.
  if (current.user?.id === user.id) return;
  useEndedSession.setState({ user, sheetPending: true });
  void write({ user, sheetShown: false });
}

/** The sheet was shown (and answered); it doesn't come back for this ended session. */
export function markEndedSheetShown(): void {
  const { user } = useEndedSession.getState();
  useEndedSession.setState({ sheetPending: false });
  if (user) void write({ user, sheetShown: true });
}

/** A sign-in, a sign-out or another account: nothing is waiting to sign in again. */
export function forgetEndedSession(): void {
  if (useEndedSession.getState().user)
    useEndedSession.setState({ user: null, sheetPending: false });
  void write(null);
}
