import * as SecureStore from 'expo-secure-store';
import {
  getSession,
  getStoredSession,
  deleteAccount as deleteAccountApi,
  type AuthUser,
} from '@/lib/authClient';
import { useUsageStore } from '@/store/useUsageStore';
import { Sentry } from '@/lib/sentry';
import type { AuthStoreLifecycle } from '@/store/createAuthStore';

const GUEST_SESSION_KEY = 'openwhispr_guest_session';

function prepareLocalData(user: AuthUser | null): void {
  const { prepareAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  prepareAccountData(user);
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
      if (isGuest && !(await getStoredSession())) {
        prepareLocalData(null);
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
      const user = await getSession({ allowOfflineCache: true });
      if (user) {
        await claimNoteShares(user);
        const sessionCookie = await getStoredSession();
        prepareLocalData(user);
        set({ user, sessionCookie, isGuest: false, isInitialized: true, isLoading: false });
      } else {
        prepareLocalData(null);
        useUsageStore.getState().reset();
        set({ user: null, sessionCookie: null, isGuest, isInitialized: true, isLoading: false });
      }
    } catch (error) {
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
