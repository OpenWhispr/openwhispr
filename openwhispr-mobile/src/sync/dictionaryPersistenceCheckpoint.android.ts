import type { SyncCheckpoint } from './syncContext';

// Storage wrappers can yield while Android switches account databases.
export function checkpointDictionaryPersistence(checkpoint: SyncCheckpoint): void {
  checkpoint();
}
