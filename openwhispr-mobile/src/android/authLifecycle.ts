import * as SecureStore from 'expo-secure-store';
import {
  deleteAccount as deleteAccountApi,
  getStoredSession,
  type AuthUser,
} from '@/android/lib/authClient';
import { useUsageStore } from '@/android/store/useUsageStore';
import { Sentry } from '@/android/lib/sentry';
import { dlog, startTimer } from '@/android/lib/debugLog';
import type { AuthStoreLifecycle } from '@/android/store/createAuthStore';
import { forgetEndedSession, markSessionEnded, readEndedSession } from './auth/endedSession';

const GUEST_SESSION_KEY = 'openwhispr_guest_session';

// The auth store is built from this lifecycle, so it is read when needed, not at import.
function authState() {
  const { useAuthStore } =
    require('@/android/store/useAuthStore') as typeof import('@/android/store/useAuthStore');
  return useAuthStore;
}
/** How long the launch check waits for the server before keeping the saved session (F3). */
export const SESSION_CHECK_TIMEOUT_MS = 5000;

// Android's own client and usage store; read when needed so a guest launch never loads them.
function androidAuth() {
  return require('@/android/lib/authClient') as typeof import('@/android/lib/authClient');
}
function androidUsage() {
  return (
    require('@/android/store/useUsageStore') as typeof import('@/android/store/useUsageStore')
  ).useUsageStore;
}

function openWorkspace(user: AuthUser | null): void {
  const { prepareAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  prepareAccountData(user);
}

/**
 * Sign-in, sign-out, guest and account deletion: whatever account comes next has its own session,
 * so nothing is left waiting to sign in again.
 */
function prepareLocalData(user: AuthUser | null): void {
  openWorkspace(user);
  forgetEndedSession();
}

/** The server ended the account on screen: keep its workspace, ask it to sign in again (F4). */
function endSession(user: AuthUser): void {
  dlog.warn('auth', 'session_ended', { kind: user.isAnonymous ? 'anonymous' : 'account' });
  if (user.isAnonymous) {
    // An anonymous session has no account to sign in to again; it ends as it always did.
    prepareLocalData(null);
    useUsageStore.getState().reset();
    authState().setState({ user: null, sessionCookie: null });
    return;
  }
  markSessionEnded(user);
  androidUsage().setState({ usage: null, loadedAt: 0, isLoading: false, sessionRejected: true });
}

/**
 * The launch's server check, run behind Home with a 5 s limit. A valid answer refreshes the
 * account; an ended one keeps the workspace and shows the sheet; no answer changes nothing.
 */
async function verifySavedSession(opened: AuthUser): Promise<void> {
  const elapsed = startTimer();
  const check = await androidAuth().checkSession(SESSION_CHECK_TIMEOUT_MS);
  dlog.info('auth', 'session_check', { state: check.state, ms: elapsed(), surface: 'background' });
  const { user: onScreen, isGuest } = authState().getState();
  // Someone signed in, out or as a guest meanwhile: their own state stands.
  if (isGuest || onScreen?.id !== opened.id) return;
  if (check.state === 'ended') {
    endSession(opened);
  } else if (check.state === 'valid') {
    if (check.user.id !== opened.id) {
      Sentry.captureMessage('Saved Android session belonged to another account', 'warning');
      dlog.warn('auth', 'session_other_account');
      prepareLocalData(check.user);
    } else {
      forgetEndedSession();
    }
    authState().setState({ user: check.user, sessionCookie: await getStoredSession() });
  }
}

export const androidAuthLifecycle: AuthStoreLifecycle = {
  prepareLocalData,
  accountScopedChats: true,
  initialize: async (set, claimNoteShares) => {
    try {
      const { retryAccountDataDeletion } =
        require('@/android/accountData') as typeof import('@/android/accountData');
      await retryAccountDataDeletion();
      const isGuest = (await SecureStore.getItemAsync(GUEST_SESSION_KEY)) === 'true';
      const cookie = await getStoredSession();
      if (isGuest && !cookie) {
        openWorkspace(null);
        forgetEndedSession();
        useUsageStore.getState().reset();
        set({
          user: null,
          sessionCookie: null,
          isGuest: true,
          isInitialized: true,
          isLoading: false,
        });
        return;
      }
      const open = async (user: AuthUser) => {
        await claimNoteShares(user);
        openWorkspace(user);
        dlog.info('auth', 'restored', { kind: user.isAnonymous ? 'anonymous' : 'account' });
        set({ user, sessionCookie: cookie, isGuest: false, isInitialized: true, isLoading: false });
      };
      const { checkSession, readSavedSession } = androidAuth();
      const saved = await readSavedSession();
      const ended = await readEndedSession();
      // Decision F3: open on the saved session; the server is asked behind Home.
      if (saved?.current && (!ended || ended.id === saved.user.id)) {
        await open(saved.user);
        if (ended) endSession(ended);
        else void verifySavedSession(saved.user).catch(() => undefined);
        return;
      }
      // A session that already expired, or one with no account saved beside it, is asked about
      // once, for at most 5 s. No session at all (signed out, a new install) never waits.
      const checkElapsed = startTimer();
      const check = cookie ? await checkSession(SESSION_CHECK_TIMEOUT_MS) : null;
      if (check)
        dlog.info('auth', 'session_check', {
          state: check.state,
          ms: checkElapsed(),
          surface: 'launch',
        });
      if (check?.state === 'valid') {
        forgetEndedSession();
        await open(check.user);
        return;
      }
      // Decision F4: the account whose session ended keeps its workspace on screen.
      const account = ended ?? saved?.user ?? null;
      if (account && !account.isAnonymous) {
        await open(account);
        if (ended || check?.state === 'ended') endSession(account);
        return;
      }
      openWorkspace(null);
      forgetEndedSession();
      useUsageStore.getState().reset();
      set({ user: null, sessionCookie: null, isGuest, isInitialized: true, isLoading: false });
    } catch (error) {
      dlog.failure('auth', 'initialize.failed', error);
      set({ isInitialized: true, isLoading: false });
      // Android keeps the database blocked until ownership is selected. Let
      // Root stop startup at its original failure instead of masking it with
      // a later collection read against that blocked database.
      throw error;
    }
  },

  finishSignOut(set) {
    try {
      prepareLocalData(null);
    } finally {
      set({ user: null, sessionCookie: null, isGuest: false, isLoading: false });
    }
  },
  async deleteAccount(user) {
    const deletedUserId = user?.id;
    await deleteAccountApi();
    if (deletedUserId) {
      const { eraseAccountData } =
        require('@/android/accountData') as typeof import('@/android/accountData');
      await eraseAccountData(deletedUserId);
      await Promise.resolve()
        .then(() => {
          const { eraseAccountInsights } =
            require('@/android/insights') as typeof import('@/android/insights');
          return eraseAccountInsights(deletedUserId);
        })
        .catch((error) => Sentry.captureException(error));
    }

    return deletedUserId;
  },
};

/**
 * A session the server refuses while the app runs (a 401 on usage) gets the same treatment as one
 * found at launch: the account stays, the 2.4 sheet shows once.
 */
export function observeEndedSessions(): () => void {
  return androidUsage().subscribe((state, previous) => {
    if (!state.sessionRejected || previous.sessionRejected) return;
    const { user, isGuest } = authState().getState();
    dlog.warn('auth', 'unauthorized', { route: 'GET /api/usage' });
    if (user && !isGuest && !user.isAnonymous) markSessionEnded(user);
  });
}
