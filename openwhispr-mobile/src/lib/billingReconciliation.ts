import { Platform } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import { useUsageStore } from '@/store/useUsageStore';

let inFlight: Promise<UsageInfo> | null = null;

export function reconcileStoreBilling(): Promise<UsageInfo> {
  if (inFlight) return inFlight;

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

  inFlight = performReconciliation(billingUserId, platform).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function performReconciliation(
  billingUserId: string,
  platform: 'ios' | 'android',
): Promise<UsageInfo> {
  // Load the native billing path only when reconciliation actually runs. This
  // keeps screens that merely import a usage gate independent of native SDKs.
  const [{ reconcileMobileBilling }, { identifyRevenueCatUser, syncRevenueCatPurchases }] =
    await Promise.all([import('@/data/remote/billingApi'), import('@/lib/revenuecat')]);

  const identified = await identifyRevenueCatUser(billingUserId);
  if (!identified) throw new Error('RevenueCat identity is unavailable');
  const synced = await syncRevenueCatPurchases();
  if (!synced) throw new Error('RevenueCat purchase sync is unavailable');
  return reconcileMobileBilling(platform);
}
