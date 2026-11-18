import { isCloudBackupEnabled } from '@/lib/cloudBackup.android';
import type { SyncPlatformPolicy } from '@/sync/createSyncEngine';

export const androidSyncPolicy: SyncPlatformPolicy = {
  isCloudBackupEnabled,
  assertAccountOwner(user) {
    const { assertAccountDataOwner } =
      require('@/android/accountData') as typeof import('@/android/accountData');
    assertAccountDataOwner(user);
  },
  onAccountMismatch() {
    // The account adapter switches databases before publishing a session.
    // A mismatch must never grant permission to delete the previous account's rows.
    throw new Error('Local account ownership mismatch.');
  },
  clearStoresOnSignOut: false,
};
