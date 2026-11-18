import { useUsageStore } from '@/store/useUsageStore';
import { identifyRevenueCatUser, recordRevenueCatPurchase } from '@/lib/revenuecat';

export async function recordPurchaseForBilling(productId: string): Promise<void> {
  const billingUserId = useUsageStore.getState().usage?.billingUserId;
  if (billingUserId) await identifyRevenueCatUser(billingUserId);
  await recordRevenueCatPurchase(productId);
}
