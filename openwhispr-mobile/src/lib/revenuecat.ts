import { createRevenueCatClient } from './revenuecatCore';

export const {
  configureRevenueCat,
  identifyRevenueCatUser,
  resetRevenueCatUser,
  reconcileRevenueCatPurchases,
  recordRevenueCatPurchase,
  getAppStorefrontCountryCode,
  showAppStoreManageSubscriptions,
} = createRevenueCatClient(true);
