import { requiresRealAccount } from '@/lib/accountAccess';
import { useAuthStore } from '@/store/useAuthStore';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

type AuthSnapshot = Pick<ReturnType<typeof useAuthStore.getState>, 'user' | 'sessionCookie'>;

// Only a real account's session reaches the keyboard: guests and anonymous onboarding
// sessions keep today's handoff, so their item is removed. The account id rides with the
// cookie, so the keyboard never sends one account's session with another's snapshot
// (KeyboardCredentialStore.cookie(from:for:)).
function keyboardCredential({ user, sessionCookie }: AuthSnapshot): string | null {
  if (requiresRealAccount(user) || !user) return null;
  if (!sessionCookie?.trim()) return null;
  return JSON.stringify({ userId: user.id, cookie: sessionCookie });
}

/**
 * Mirrors the session cookie into one Keychain item shared with the keyboard through the App
 * Group, so the keyboard can transcribe without opening the app. Writes only on a change, and
 * tries again after a failed write.
 */
export function startKeyboardCredentialSync(): () => void {
  let written: string | null | undefined;
  const sync = (state: AuthSnapshot): void => {
    const next = keyboardCredential(state);
    if (next === written) return;
    if (AppGroupStorage.setKeyboardSessionCredential(next)) written = next;
  };
  sync(useAuthStore.getState());
  return useAuthStore.subscribe(sync);
}
