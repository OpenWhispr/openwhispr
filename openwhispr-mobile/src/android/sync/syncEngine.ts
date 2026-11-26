import { androidSyncPolicy } from '@/android/syncPolicy';
import { createSyncEngine } from '@/android/sync/createSyncEngine';

export type { SyncReason } from '@/android/sync/createSyncEngine';
export const { subscribeSyncCompletion, requestSync, initSyncTriggers, teardownSyncTriggers } =
  createSyncEngine(androidSyncPolicy);
