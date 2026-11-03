import type { SyncCheckpoint } from './syncContext';

// Keep the upstream iOS checkpoint sequence around shared-dictionary storage.
export function checkpointDictionaryPersistence(_checkpoint: SyncCheckpoint): void {}
