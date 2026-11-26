import { create } from 'zustand';
import { ApiError } from '@/android/lib/apiClient';
import {
  createUsageState,
  type UsageLifecycle,
  type UsageStore,
} from '@/android/store/createUsageStore';

export { getUsageOwnerKey } from '@/android/store/createUsageStore';
export type { UsageLoadResult } from '@/android/store/createUsageStore';

interface AndroidUsageState {
  sessionRejected: boolean;
}

const androidUsageLifecycle: UsageLifecycle<AndroidUsageState> = {
  clearedState: { sessionRejected: false },
  onFailure: (error, isCurrent) => {
    if (!isCurrent) return { status: 'stale' };
    if (error instanceof ApiError && error.status === 401) {
      // A rejected session cannot keep advertising cached cloud access. Keep
      // the local account open so reauthentication does not hide its work.
      return {
        status: 'failed',
        state: { usage: null, loadedAt: 0, isLoading: false, sessionRejected: true },
      };
    }
    return { status: 'failed', state: { isLoading: false } };
  },
};

export const useUsageStore = create<UsageStore & AndroidUsageState>((set, get) =>
  createUsageState(set, get, androidUsageLifecycle),
);
