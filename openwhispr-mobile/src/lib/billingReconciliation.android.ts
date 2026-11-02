import type { UsageInfo } from '@/data/remote/usageApi';
import {
  getBillingIdentity,
  isBillingIdentityCurrent,
  type BillingIdentity,
} from './billingIdentity';

const inFlight = new Map<string, Promise<UsageInfo>>();

export function reconcileStoreBilling(): Promise<UsageInfo> {
  const identity = getBillingIdentity();
  if (!identity) return Promise.reject(new Error('Billing identity is unavailable'));

  const key = JSON.stringify([identity.userId, identity.sessionCookie, identity.billingUserId]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = performReconciliation(identity).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function performReconciliation(identity: BillingIdentity): Promise<UsageInfo> {
  const { reconcileMobileBilling } =
    require('@/data/remote/billingApi') as typeof import('@/data/remote/billingApi');
  const { withRevenueCatUser } = require('@/lib/revenuecat') as typeof import('@/lib/revenuecat');
  const checkIdentity = () => {
    if (!isBillingIdentityCurrent(identity)) throw new Error('Billing account changed');
  };

  // Restore is an explicit purchase-controller action. A status retry only selects
  // the matching RevenueCat user; it must not sync store-wide receipts implicitly.
  await withRevenueCatUser(identity.billingUserId, async () => undefined, checkIdentity);
  checkIdentity();
  const usage = await reconcileMobileBilling('android', identity.sessionCookie);
  checkIdentity();
  return usage;
}
