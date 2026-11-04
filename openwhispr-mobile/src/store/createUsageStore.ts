import { fetchUsage, type UsageInfo } from '@/data/remote/usageApi';
import { useAuthStore } from '@/store/useAuthStore';

const CACHE_TTL_MS = 60_000;

export type UsageLoadResult =
  | { status: 'loaded'; usage: UsageInfo; loadedAt: number }
  | { status: 'skipped'; reason: 'fresh' | 'loading' | 'unauthenticated'; usage: UsageInfo | null }
  | { status: 'stale'; usage: UsageInfo | null }
  | { status: 'failed'; error: unknown; usage: UsageInfo | null };

export interface UsageStore {
  usage: UsageInfo | null;
  isLoading: boolean;
  loadedAt: number;
  ownerKey: string | null;
  activeRequestId: number;
  isBillingSessionActive: boolean;
  load: (force?: boolean) => Promise<UsageLoadResult>;
  beginBillingSession: () => void;
  endBillingSession: () => void;
  reset: () => void;
}

export function getUsageOwnerKey(): string | null {
  const { user, isGuest, sessionCookie } = useAuthStore.getState();
  if (!user || isGuest || !sessionCookie) return null;
  return `${user.id}:${sessionCookie}`;
}

export interface UsageLifecycle<ExtraState extends object> {
  clearedState: ExtraState;
  onFailure: (
    error: unknown,
    isCurrent: boolean,
  ) => {
    status: 'failed' | 'stale';
    state?: Partial<UsageStore> & Partial<ExtraState>;
  };
}

export const defaultUsageLifecycle: UsageLifecycle<Record<never, never>> = {
  clearedState: {},
  onFailure: (_error, isCurrent) => ({
    status: 'failed',
    state: isCurrent ? { isLoading: false } : undefined,
  }),
};

export function createUsageState<ExtraState extends object>(
  set: (state: Partial<UsageStore>) => void,
  get: () => UsageStore,
  lifecycle: UsageLifecycle<ExtraState>,
): UsageStore & ExtraState {
  let nextRequestId = 0;
  return {
    usage: null,
    isLoading: false,
    loadedAt: 0,
    ownerKey: null,
    activeRequestId: 0,
    ...lifecycle.clearedState,
    isBillingSessionActive: false,

    load: async (force = false) => {
      const ownerKey = getUsageOwnerKey();
      if (!ownerKey) {
        set({
          usage: null,
          isLoading: false,
          loadedAt: 0,
          ownerKey: null,
          ...lifecycle.clearedState,
        });
        return { status: 'skipped', reason: 'unauthenticated', usage: null };
      }

      const current = get();
      if (current.ownerKey && current.ownerKey !== ownerKey) {
        set({ usage: null, loadedAt: 0, ownerKey, ...lifecycle.clearedState });
      }

      const { loadedAt, isLoading, usage } = get();
      if (!force && Date.now() - loadedAt < CACHE_TTL_MS) {
        return { status: 'skipped', reason: 'fresh', usage };
      }
      if (isLoading && !force) {
        return { status: 'skipped', reason: 'loading', usage };
      }

      const requestId = ++nextRequestId;
      set({ isLoading: true, ownerKey, activeRequestId: requestId });
      try {
        const freshUsage = await fetchUsage();
        const freshLoadedAt = Date.now();
        if (getUsageOwnerKey() !== ownerKey || get().activeRequestId !== requestId) {
          return { status: 'stale', usage: get().usage };
        }

        set({
          usage: freshUsage,
          isLoading: false,
          loadedAt: freshLoadedAt,
          ownerKey,
          ...lifecycle.clearedState,
        });
        return { status: 'loaded', usage: freshUsage, loadedAt: freshLoadedAt };
      } catch (error) {
        const isCurrent = getUsageOwnerKey() === ownerKey && get().activeRequestId === requestId;
        const failure = lifecycle.onFailure(error, isCurrent);
        if (failure.state) set(failure.state);
        return failure.status === 'stale'
          ? { status: 'stale', usage: get().usage }
          : { status: 'failed', error, usage: get().usage };
      }
    },

    beginBillingSession: () => set({ isBillingSessionActive: true }),

    endBillingSession: () => set({ isBillingSessionActive: false }),

    reset: () => {
      const requestId = ++nextRequestId;
      set({
        usage: null,
        isLoading: false,
        loadedAt: 0,
        ownerKey: null,
        activeRequestId: requestId,
        ...lifecycle.clearedState,
        isBillingSessionActive: false,
      });
    },
  };
}
