import { Platform } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import {
  getBillingIdentity,
  isBillingIdentityCurrent,
  type BillingIdentity,
} from './billingIdentity';

let inFlight: { identity: BillingIdentity; promise: Promise<UsageInfo> } | null = null;

export function reconcileStoreBilling(): Promise<UsageInfo> {
  if (inFlight && isBillingIdentityCurrent(inFlight.identity)) return inFlight.promise;

  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return Promise.reject(
      new Error('Store billing reconciliation is unavailable on this platform'),
    );
  }

  const platform = Platform.OS;
  const identity = getBillingIdentity();
  if (!identity) {
    return Promise.reject(new Error('Billing identity is unavailable'));
  }

  const promise = performReconciliation(identity, platform).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { identity, promise };
  return promise;
}

async function performReconciliation(
  identity: BillingIdentity,
  platform: 'ios' | 'android',
): Promise<UsageInfo> {
  // Load the native billing path only when reconciliation actually runs. This
  // keeps screens that merely import a usage gate independent of native SDKs.
  const { reconcileMobileBilling } =
    require('@/data/remote/billingApi') as typeof import('@/data/remote/billingApi');
  const { reconcileRevenueCatPurchases } =
    require('@/lib/revenuecat') as typeof import('@/lib/revenuecat');

  const current = () => isBillingIdentityCurrent(identity);
  const synced = await reconcileRevenueCatPurchases(identity.billingUserId, current);
  if (!synced) throw new Error('RevenueCat purchase sync is unavailable');
  if (!current()) throw new Error('Billing account changed');
  const usage = await reconcileMobileBilling(platform, identity.sessionCookie);
  if (!current()) throw new Error('Billing account changed');
  return usage;
}
