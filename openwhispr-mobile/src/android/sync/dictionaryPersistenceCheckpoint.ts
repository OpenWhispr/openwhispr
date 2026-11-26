import type { SyncCheckpoint } from '@/android/shared/sync/syncContext';

// Storage wrappers can yield while Android switches account databases.
export function checkpointDictionaryPersistence(checkpoint: SyncCheckpoint): void {
  checkpoint();
}
