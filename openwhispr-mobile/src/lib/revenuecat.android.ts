import Purchases from 'react-native-purchases';
import { createRevenueCatClient } from './revenuecatCore';

const client = createRevenueCatClient(false);
export const {
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

// Keep the same SDK identity throughout the store interaction and queued identity work.
export function withRevenueCatUser<T>(
  userId: string,
  operation: () => Promise<T>,
  checkIdentity?: () => void,
): Promise<T> {
  return client.enqueueBilling(async () => {
    checkIdentity?.();
    configureRevenueCat();
    if (!client.isConfigured()) throw new Error('Store billing is not configured in this build.');
    await Purchases.logIn(userId);
    checkIdentity?.();
    return operation();
  });
}
