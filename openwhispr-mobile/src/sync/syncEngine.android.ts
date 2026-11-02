import { androidSyncPolicy } from '@/android/syncPolicy';
import { createSyncEngine } from './createSyncEngine';

export type { SyncReason } from './createSyncEngine';
export const { subscribeSyncCompletion, requestSync, initSyncTriggers, teardownSyncTriggers } =
  createSyncEngine(androidSyncPolicy);
