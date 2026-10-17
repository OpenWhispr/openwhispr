import { Platform } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';

const inFlight = new Map<string, Promise<UsageInfo>>();

export function reconcileStoreBilling(): Promise<UsageInfo> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return Promise.reject(
      new Error('Store billing reconciliation is unavailable on this platform'),
    );
  }

  const platform = Platform.OS;
  const billingUserId = useUsageStore.getState().usage?.billingUserId;
  if (!billingUserId) {
    return Promise.reject(new Error('Billing identity is unavailable'));
  }

  const owner = getUsageOwnerKey();
  if (!owner) return Promise.reject(new Error('Sign in to check billing.'));
  const key = `${platform}:${owner}:${billingUserId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = performReconciliation(billingUserId, platform, owner).finally(() =>
    inFlight.delete(key),
  );
  inFlight.set(key, request);
  return request;
}

async function performReconciliation(
  billingUserId: string,
  platform: 'ios' | 'android',
  owner: string,
): Promise<UsageInfo> {
  // Load the native billing path only when reconciliation actually runs. This
  // keeps screens that merely import a usage gate independent of native SDKs.
  const [{ reconcileMobileBilling }, { withRevenueCatUser, syncRevenueCatPurchases }] =
    await Promise.all([import('@/data/remote/billingApi'), import('@/lib/revenuecat')]);

  const checkIdentity = () => {
    if (
      getUsageOwnerKey() !== owner ||
      useUsageStore.getState().usage?.billingUserId !== billingUserId
    )
      throw new Error('Billing account changed.');
  };
  checkIdentity();
  if (platform === 'ios') {
    const synced = await syncRevenueCatPurchases(billingUserId, checkIdentity);
    if (!synced) throw new Error('RevenueCat purchase sync is unavailable');
  } else {
    await withRevenueCatUser(billingUserId, async () => undefined, checkIdentity);
  }
  checkIdentity();
  const usage = await reconcileMobileBilling(platform);
  checkIdentity();
  return usage;
}
