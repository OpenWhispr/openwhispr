import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { SyncCancelledError, type SyncCheckpoint } from './syncContext';

export function createSyncContext(): { checkpoint: SyncCheckpoint; dispose: () => void } {
  const { user, sessionCookie } = useAuthStore.getState();
  const userId = user?.id;
  const backupEnabled = useConfigStore.getState().config?.cloudBackupEnabled ?? true;
  let identityChanged = false;
  let backupDisabled = false;
  const unsubscribeAuth = useAuthStore.subscribe((state) => {
    if (
      state.user?.id !== userId ||
      state.sessionCookie !== sessionCookie ||
      state.isGuest ||
      state.isLoading
    ) {
      identityChanged = true;
    }
  });
  // Only the toggle itself counts: every preference save flips the store's
  // isLoading, and a storage error is not an opt-out.
  const unsubscribeConfig = useConfigStore.subscribe((state) => {
    if (state.config?.cloudBackupEnabled === false) backupDisabled = true;
  });
  return {
    checkpoint: (upload = false): void => {
      const current = useAuthStore.getState();
      if (
        identityChanged ||
        current.user?.id !== userId ||
        current.sessionCookie !== sessionCookie ||
        current.isGuest ||
        current.isLoading
      ) {
        throw new SyncCancelledError();
      }
      if (
        upload &&
        backupEnabled &&
        (backupDisabled || useConfigStore.getState().config?.cloudBackupEnabled === false)
      ) {
        throw new SyncCancelledError();
      }
    },
    dispose: (): void => {
      unsubscribeAuth();
      unsubscribeConfig();
    },
  };
}
