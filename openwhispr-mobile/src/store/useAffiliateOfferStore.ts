import { create } from 'zustand';
import type { AffiliateOffer } from '@/lib/affiliateOffer';
import {
  getBillingIdentity,
  isBillingIdentityCurrent,
  type BillingIdentity,
} from '@/lib/billingIdentity';
import { useUsageStore } from './useUsageStore';

export const useAffiliateOfferStore = create<{
  offer: AffiliateOffer | null;
  identity: BillingIdentity | null;
}>(() => ({ offer: null, identity: null }));
let showing: { identity: BillingIdentity; promise: Promise<boolean> } | null = null;
let finish: (() => void) | null = null;
let revision = 0;
export function closeAffiliateOffer(): void {
  revision += 1;
  showing = null;
  if (useAffiliateOfferStore.getState().offer) useUsageStore.getState().endBillingSession();
  useAffiliateOfferStore.setState({ offer: null, identity: null });
  finish?.();
  finish = null;
}
export function presentAffiliateOffer(isCurrent: () => boolean = () => true): Promise<boolean> {
  const identity = getBillingIdentity();
  if (!identity || !isCurrent()) return Promise.resolve(false);
  if (showing && isBillingIdentityCurrent(showing.identity)) return showing.promise;
  if (showing) closeAffiliateOffer();
  const version = revision;
  const promise = (async () => {
    const { loadAffiliateOffer } =
      require('@/lib/affiliateOffer') as typeof import('@/lib/affiliateOffer');
    const offer = await loadAffiliateOffer();
    if (
      !isCurrent() ||
      version !== revision ||
      !offer ||
      !isBillingIdentityCurrent(identity) ||
      useUsageStore.getState().usage?.isSubscribed
    )
      return false;
    useUsageStore.getState().beginBillingSession();
    useAffiliateOfferStore.setState({ offer, identity });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return true;
  })().finally(() => {
    if (showing?.promise === promise) showing = null;
  });
  showing = { identity, promise };
  return promise;
}
