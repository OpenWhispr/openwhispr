import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';
import { useAuthStore } from './useAuthStore';
import { useConfigStore } from './useConfigStore';
import { AffiliateConsentError, checkAndClaimAffiliate } from '@/lib/affiliateAttribution';
import { ApiError } from '@/lib/apiClient';
import { isUsageAnalyticsAllowed } from '@/lib/usageAnalytics';
import { AffiliateInputError, getAffiliateClientConfig } from '@/lib/affiliateLink';

const STORAGE_KEY = 'openwhispr_affiliate_candidate_v1';
// Shown as-is; the Account row picks its follow-up action from which one it is.
export const AFFILIATE_ERRORS = {
  tracking: 'Creator links need tracking permission. You can allow it in Settings.',
  analytics: 'Creator links are unavailable while Usage Analytics is off.',
  input: 'Enter your exact creator code, or paste the original creator link.',
  unavailable: 'This creator link is unavailable. Try another link.',
  review: 'We couldn’t confirm this referral.',
  check: 'We couldn’t check your link. Try again.',
  save: 'We couldn’t save your link. Try again.',
} as const;
const candidateSchema = z.object({
  ownerId: z.string().nullable(),
  ownerAnonymous: z.boolean().default(false),
  link: z.string().max(2048),
  clickId: z.string().nullable(),
  saved: z.boolean(),
  autoSubmit: z.boolean(),
  inboundOfferPending: z.boolean().default(false),
});
type Candidate = z.infer<typeof candidateSchema>;
const empty: Candidate = {
  ownerId: null,
  ownerAnonymous: false,
  link: '',
  clickId: null,
  saved: false,
  autoSubmit: false,
  inboundOfferPending: false,
};
interface AffiliateState extends Candidate {
  hydrated: boolean;
  checking: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  bindSession: () => Promise<void>;
  edit: (link: string, autoSubmit?: boolean) => Promise<void>;
  prepare: (isCallerCurrent?: () => boolean) => Promise<boolean>;
  consumeInboundOffer: (isCallerCurrent: () => boolean) => Promise<boolean>;
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
    ownerAnonymous: state.ownerAnonymous,
    link: state.link,
    clickId: state.clickId,
    saved: state.saved,
    autoSubmit: state.autoSubmit,
    inboundOfferPending: state.inboundOfferPending,
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
    const ownerAnonymous = auth.user?.isAnonymous === true;
    const state = get();
    if (state.ownerId === ownerId) return;
    revision += 1;
    // A candidate captured before session creation binds for the first time, and one
    // not yet claimed follows its anonymous session into the account it becomes.
    // A claimed one transfers through the server's replayable link workflow.
    const carriesOver =
      ownerId !== null && (state.ownerId === null || (state.ownerAnonymous && !state.saved));
    set(
      carriesOver
        ? { ownerId, ownerAnonymous, checking: false }
        : { ...empty, ownerId, ownerAnonymous, checking: false, error: null },
    );
    try {
      await persist(snapshot(get()));
    } catch {
      set({ error: AFFILIATE_ERRORS.save });
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
      inboundOfferPending: autoSubmit,
      ownerId: useAuthStore.getState().user?.id ?? null,
      ownerAnonymous: useAuthStore.getState().user?.isAnonymous === true,
    });
    try {
      await persist(snapshot(get()));
    } catch {
      set({ error: AFFILIATE_ERRORS.save });
    }
  },
  consumeInboundOffer: async (isCallerCurrent) => {
    await get().hydrate();
    await get().bindSession();
    if (!isCallerCurrent() || !get().inboundOfferPending) return false;
    const version = revision;
    const current = () => isCallerCurrent() && revision === version;
    // The arrival hook may already be claiming this exact link after consent.
    // Let its bounded request settle rather than submitting a duplicate claim.
    if (get().checking)
      await new Promise<void>((resolve) => {
        let unsubscribe = () => {};
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, 10_000);
        unsubscribe = useAffiliateStore.subscribe((state) => {
          if (!state.checking || !current()) finish();
        });
      });
    if (
      !current() ||
      get().checking ||
      !(await get().prepare(current)) ||
      !get().saved ||
      !current() ||
      !get().inboundOfferPending
    )
      return false;
    set({ inboundOfferPending: false });
    await persist(snapshot(get()));
    return current();
  },
  prepare: async (isCallerCurrent = () => true) => {
    if (!getAffiliateClientConfig()) return true;
    await get().hydrate();
    await get().bindSession();
    if (!isCallerCurrent()) return false;
    const state = get();
    if (!state.link.trim() || state.saved) return true;
    if (state.checking) return false;
    const auth = useAuthStore.getState();
    if (!isUsageAnalyticsAllowed(useConfigStore.getState().config)) {
      set({ error: AFFILIATE_ERRORS.analytics });
      return false;
    }
    if (!auth.user || !auth.sessionCookie || state.ownerId !== auth.user.id) {
      set({ error: AFFILIATE_ERRORS.check });
      return false;
    }
    const version = revision;
    const ownsCandidate = () =>
      revision === version &&
      useAuthStore.getState().user?.id === auth.user?.id &&
      useAuthStore.getState().sessionCookie === auth.sessionCookie &&
      isUsageAnalyticsAllowed(useConfigStore.getState().config);
    const isCurrent = () => isCallerCurrent() && ownsCandidate();
    // A refused link stays refused: stop retrying an inbound one on every resume,
    // and don't claim it again for the onboarding offer.
    const stopAutoSubmit = async () => {
      if (!get().autoSubmit && !get().inboundOfferPending) return;
      set({ autoSubmit: false, inboundOfferPending: false });
      await persist(snapshot(get())).catch(() => {});
    };
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
      // A claim the server accepted is saved even when its caller gave up waiting,
      // so a retry finds it saved rather than trying to claim another creator.
      if (!ownsCandidate()) return false;
      if (status === 'review') {
        if (isCallerCurrent()) set({ error: AFFILIATE_ERRORS.review });
        await stopAutoSubmit();
        return false;
      }
      set({ saved: true, autoSubmit: false });
      await persist(snapshot(get()));
      return isCurrent();
    } catch (error) {
      if (!isCurrent()) return false;
      if (error instanceof AffiliateConsentError) {
        set({ error: AFFILIATE_ERRORS.tracking });
      } else if (error instanceof AffiliateInputError) {
        set({ error: AFFILIATE_ERRORS.input });
        await stopAutoSubmit();
      } else if (error instanceof ApiError && error.status === 400) {
        set({ error: AFFILIATE_ERRORS.unavailable });
        await stopAutoSubmit();
      } else {
        set({ error: AFFILIATE_ERRORS.check });
      }
      return false;
    } finally {
      if (revision === version) set({ checking: false });
    }
  },
}));
