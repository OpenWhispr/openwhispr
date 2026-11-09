import { createRevenueCatClient } from './revenuecatCore';

const client = createRevenueCatClient(false, true);
export const {
  withRevenueCatUser,
  configureRevenueCat,
  identifyRevenueCatUser,
  resetRevenueCatUser,
  reconcileRevenueCatPurchases,
  getAppStorefrontCountryCode,
  showAppStoreManageSubscriptions,
} = client;

// Android's purchase controller already completes transactions through RevenueCat.
export async function recordRevenueCatPurchase(
  _productId: string,
  _userId?: string,
  _checkIdentity?: () => void,
): Promise<boolean> {
  return false;
}
