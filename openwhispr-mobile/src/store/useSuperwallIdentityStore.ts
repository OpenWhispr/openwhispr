import { create } from 'zustand';
import { useUsageStore } from '@/store/useUsageStore';

// How long a paywall waits for the identity before giving up. An App Store
// purchase made before identify() reaches the server with no app user id, so
// it can never be attributed; a missed paywall is the lesser loss.
export const SUPERWALL_IDENTITY_WAIT_MS = 3_000;

type SuperwallIdentityStore = {
  // The billing user id Superwall is currently identified as, or null when it
  // is anonymous or the identity is not known to be in place.
  identifiedBillingUserId: string | null;
  setIdentifiedBillingUserId: (billingUserId: string | null) => void;
};

export const useSuperwallIdentityStore = create<SuperwallIdentityStore>((set) => ({
  identifiedBillingUserId: null,
  setIdentifiedBillingUserId: (identifiedBillingUserId) => set({ identifiedBillingUserId }),
}));

// Compared against the account's own billing id so an identity left over from a
// previous account never counts as ready.
export function isSuperwallIdentityReadyFor(
  identifiedBillingUserId: string | null,
  billingUserId: string | null | undefined,
): boolean {
  return identifiedBillingUserId !== null && identifiedBillingUserId === (billingUserId ?? null);
}

export function isSuperwallIdentityReady(): boolean {
  return isSuperwallIdentityReadyFor(
    useSuperwallIdentityStore.getState().identifiedBillingUserId,
    useUsageStore.getState().usage?.billingUserId,
  );
}

/** Resolves true once the identity matches the account's billing id, false on timeout or abort. */
export function waitForSuperwallIdentity(
  timeoutMs: number = SUPERWALL_IDENTITY_WAIT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isSuperwallIdentityReady()) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(isSuperwallIdentityReady()), timeoutMs);
    const unsubscribe = useSuperwallIdentityStore.subscribe(() => {
      if (isSuperwallIdentityReady()) finish(true);
    });
    signal?.addEventListener('abort', onAbort);
  });
}
