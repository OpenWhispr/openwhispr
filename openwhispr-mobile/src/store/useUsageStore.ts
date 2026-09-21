import { create } from 'zustand';
import { fetchUsage, type UsageInfo } from '@/data/remote/usageApi';
import { useAuthStore } from '@/store/useAuthStore';

const CACHE_TTL_MS = 60_000;

export type UsageLoadResult =
  | { status: 'loaded'; usage: UsageInfo; loadedAt: number }
  | { status: 'skipped'; reason: 'fresh' | 'loading' | 'unauthenticated'; usage: UsageInfo | null }
  | { status: 'stale'; usage: UsageInfo | null }
  | { status: 'failed'; error: unknown; usage: UsageInfo | null };

interface UsageStore {
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

let nextRequestId = 0;

function getUsageOwnerKey(): string | null {
  const { user, isGuest, sessionCookie } = useAuthStore.getState();
  if (!user || isGuest || !sessionCookie) return null;
  return `${user.id}:${sessionCookie}`;
}

export const useUsageStore = create<UsageStore>((set, get) => ({
  usage: null,
  isLoading: false,
  loadedAt: 0,
  ownerKey: null,
  activeRequestId: 0,
  isBillingSessionActive: false,

  load: async (force = false) => {
    const ownerKey = getUsageOwnerKey();
    if (!ownerKey) {
      set({ usage: null, isLoading: false, loadedAt: 0, ownerKey: null });
      return { status: 'skipped', reason: 'unauthenticated', usage: null };
    }

    const current = get();
    if (current.ownerKey && current.ownerKey !== ownerKey) {
      set({ usage: null, loadedAt: 0, ownerKey });
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

      set({ usage: freshUsage, isLoading: false, loadedAt: freshLoadedAt, ownerKey });
      return { status: 'loaded', usage: freshUsage, loadedAt: freshLoadedAt };
    } catch (error) {
      if (getUsageOwnerKey() === ownerKey && get().activeRequestId === requestId) {
        set({ isLoading: false });
      }
      return { status: 'failed', error, usage: get().usage };
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
      isBillingSessionActive: false,
    });
  },
}));
