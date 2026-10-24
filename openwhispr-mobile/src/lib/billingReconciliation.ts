import { Platform } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import {
  getBillingIdentity,
  isBillingIdentityCurrent,
  type BillingIdentity,
} from './billingIdentity';

const inFlight = new Map<string, Promise<UsageInfo>>();

export function reconcileStoreBilling(): Promise<UsageInfo> {
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

  const key = JSON.stringify([
    platform,
    identity.userId,
    identity.sessionCookie,
    identity.billingUserId,
  ]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = performReconciliation(identity, platform).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
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
  const { reconcileRevenueCatPurchases, withRevenueCatUser } =
    require('@/lib/revenuecat') as typeof import('@/lib/revenuecat');

  const current = () => isBillingIdentityCurrent(identity);
  if (platform === 'ios') {
    const synced = await reconcileRevenueCatPurchases(identity.billingUserId, current);
    if (!synced) throw new Error('RevenueCat purchase sync is unavailable');
  } else {
    // Android restores explicitly through its purchase controller. A status
    // retry must not perform an unsolicited store-wide receipt synchronization.
    await withRevenueCatUser(
      identity.billingUserId,
      async () => undefined,
      () => {
        if (!current()) throw new Error('Billing account changed');
      },
    );
  }
  if (!current()) throw new Error('Billing account changed');
  const usage = await reconcileMobileBilling(platform, identity.sessionCookie);
  if (!current()) throw new Error('Billing account changed');
  return usage;
}
