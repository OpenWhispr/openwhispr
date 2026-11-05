import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';
import { recordRevenueCatPurchase } from '@/lib/revenuecat.android';

export async function recordPurchaseForBilling(productId: string): Promise<void> {
  const billingUserId = useUsageStore.getState().usage?.billingUserId;
  const owner = getUsageOwnerKey();
  if (!billingUserId || !owner) return;
  await recordRevenueCatPurchase(productId, billingUserId, () => {
    if (
      getUsageOwnerKey() !== owner ||
      useUsageStore.getState().usage?.billingUserId !== billingUserId
    )
      throw new Error('Billing account changed.');
  });
}
