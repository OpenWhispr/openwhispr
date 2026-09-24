import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';
import { useAuthStore } from './useAuthStore';
import { useConfigStore } from './useConfigStore';
import { AffiliateConsentError, checkAndClaimAffiliate } from '@/lib/affiliateAttribution';
import { ApiError } from '@/lib/apiClient';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';

const STORAGE_KEY = 'openwhispr_affiliate_candidate_v1';
const candidateSchema = z.object({
  ownerId: z.string().nullable(),
  link: z.string().max(2048),
  clickId: z.string().nullable(),
  saved: z.boolean(),
  autoSubmit: z.boolean(),
});
type Candidate = z.infer<typeof candidateSchema>;
const empty: Candidate = {
  ownerId: null,
  link: '',
  clickId: null,
  saved: false,
  autoSubmit: false,
};
interface AffiliateState extends Candidate {
  hydrated: boolean;
  checking: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  bindSession: () => Promise<void>;
  edit: (link: string, autoSubmit?: boolean) => Promise<void>;
  prepare: () => Promise<boolean>;
}
let revision = 0;
let writeQueue: Promise<void> = Promise.resolve();
function persist(candidate: Candidate): Promise<void> {
  const value = JSON.stringify(candidate);
  writeQueue = writeQueue.catch(() => {}).then(() => AsyncStorage.setItem(STORAGE_KEY, value));
  return writeQueue;
}
function snapshot(state: Candidate): Candidate {
  return {
    ownerId: state.ownerId,
    link: state.link,
    clickId: state.clickId,
    saved: state.saved,
    autoSubmit: state.autoSubmit,
  };
}
export const useAffiliateStore = create<AffiliateState>((set, get) => ({
  ...empty,
  hydrated: false,
  checking: false,
  error: null,
  hydrate: async () => {
    if (get().hydrated) return;
    const version = revision;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = candidateSchema.safeParse(raw ? JSON.parse(raw) : empty);
      if (version === revision) set(parsed.success ? parsed.data : empty);
    } catch {
      /* Keep the flow usable if local storage is unavailable. */
    }
    set({ hydrated: true });
  },
  bindSession: async () => {
    const auth = useAuthStore.getState();
    if (!get().hydrated || !auth.isInitialized) return;
    const ownerId = auth.user?.id ?? null;
    const state = get();
    if (state.ownerId === ownerId) return;
    revision += 1;
    // Only a candidate captured before session creation can bind for the first time.
    // Anonymous-to-account transfer belongs to the server's replayable link workflow.
    set(
      state.ownerId === null && ownerId
        ? { ownerId, checking: false }
        : { ...empty, ownerId, checking: false, error: null },
    );
    try {
      await persist(snapshot(get()));
    } catch {
      set({ error: 'We couldn’t save your link. Try again.' });
    }
  },
  edit: async (link, autoSubmit = false) => {
    if (get().saved || get().checking) return;
    revision += 1;
    set({
      link: link.slice(0, 2048),
      clickId: null,
      error: null,
      autoSubmit,
      ownerId: useAuthStore.getState().user?.id ?? null,
    });
    try {
      await persist(snapshot(get()));
    } catch {
      set({ error: 'We couldn’t save your link. Try again.' });
    }
  },
  prepare: async () => {
    if (!getAffiliateClientConfig()) return true;
    await get().hydrate();
    await get().bindSession();
    const state = get();
    if (!state.link.trim() || state.saved) return true;
    if (state.checking) return false;
    const auth = useAuthStore.getState();
    const config = useConfigStore.getState().config;
    if (!config || config.usageAnalyticsEnabled === false) {
      set({
        error:
          'Creator links are unavailable while Usage Analytics is off. Clear the field to continue.',
      });
      return false;
    }
    if (!auth.user || !auth.sessionCookie || state.ownerId !== auth.user.id) {
      set({ error: 'We couldn’t check your link. Try again, or clear the field to continue.' });
      return false;
    }
    const version = revision;
    const isCurrent = () =>
      revision === version &&
      useAuthStore.getState().user?.id === auth.user?.id &&
      useAuthStore.getState().sessionCookie === auth.sessionCookie &&
      useConfigStore.getState().config?.usageAnalyticsEnabled !== false;
    set({ checking: true, error: null });
    try {
      const status = await checkAndClaimAffiliate(
        state.link,
        state.clickId,
        auth.sessionCookie,
        isCurrent,
        async (clickId) => {
          if (!isCurrent()) return;
          set({ clickId });
          await persist(snapshot(get()));
        },
      );
      if (!isCurrent()) return false;
      if (status === 'review') {
        set({ error: 'We couldn’t confirm this referral. Clear the field to continue.' });
        return false;
      }
      set({ saved: true, autoSubmit: false });
      await persist(snapshot(get()));
      return isCurrent();
    } catch (error) {
      if (isCurrent())
        set({
          error:
            error instanceof AffiliateConsentError
              ? 'Creator links are unavailable with your current tracking settings. Clear the field to continue.'
              : error instanceof ApiError && error.status === 400
                ? 'This creator link is unavailable. Try another link, or clear the field to continue.'
                : 'We couldn’t check your link. Try again, or clear the field to continue.',
        });
      return false;
    } finally {
      if (revision === version) set({ checking: false });
    }
  },
}));
