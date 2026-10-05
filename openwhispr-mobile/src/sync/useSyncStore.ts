import { create } from 'zustand';

export type SyncStatus = 'idle' | 'running' | 'error';

interface SyncStore {
  status: SyncStatus;
  lastError: Error | null;
  lastSyncAt: string | null;
  subscriptionRequired: boolean;
  policyBlocked: boolean;
  set: (patch: Partial<SyncStore>) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: 'idle',
  lastError: null,
  lastSyncAt: null,
  subscriptionRequired: false,
  policyBlocked: false,
  set: (patch) => set(patch),
}));
