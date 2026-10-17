import { Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ARE_COMPLETED_BY_TYPE,
  STOREKIT_VERSION,
} from 'react-native-purchases';
import { Sentry } from '@/lib/sentry';

let configured = false;

function getRevenueCatApiKey(): string | undefined {
  const key =
    Platform.OS === 'ios'
      ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY
      : Platform.OS === 'android'
        ? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY
        : undefined;
  return key?.trim() || undefined;
}

function reportRevenueCatError(operation: string, error: unknown): void {
  Sentry.captureException(error, { tags: { feature: 'revenuecat', operation } });
}

// iOS observes Superwall/StoreKit purchases; Android uses RevenueCat as its sole
// purchase controller. Backend entitlements remain the authority for app access.
export function configureRevenueCat(): void {
  if (configured) return;
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) return;

  try {
    Purchases.configure({
      apiKey,
      ...(Platform.OS === 'ios'
        ? {
            purchasesAreCompletedBy: {
              type: PURCHASES_ARE_COMPLETED_BY_TYPE.MY_APP,
              storeKitVersion: STOREKIT_VERSION.STOREKIT_2,
            },
          }
        : {}),
    });
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.INFO);
    configured = true;
  } catch (error) {
    reportRevenueCatError('configure', error);
  }
}

let billingQueue: Promise<unknown> = Promise.resolve();
function enqueueBilling<T>(operation: () => Promise<T>): Promise<T> {
  const next = billingQueue.then(operation, operation);
  billingQueue = next.catch(() => undefined);
  return next;
}

// Identity stays fixed for the entire store interaction, including permission/payment UI.
export function withRevenueCatUser<T>(
  userId: string,
  operation: () => Promise<T>,
  checkIdentity?: () => void,
): Promise<T> {
  return enqueueBilling(async () => {
    checkIdentity?.();
    configureRevenueCat();
    if (!configured) throw new Error('Store billing is not configured in this build.');
    await Purchases.logIn(userId);
    checkIdentity?.();
    return operation();
  });
}

export async function identifyRevenueCatUser(userId: string): Promise<boolean> {
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    await withRevenueCatUser(userId, async () => undefined);
    return true;
  } catch (error) {
    reportRevenueCatError('identify', error);
    return false;
  }
}

export async function resetRevenueCatUser(): Promise<void> {
  if (!configured) return;
  try {
    await enqueueBilling(() => Purchases.logOut());
  } catch (error) {
    reportRevenueCatError('reset', error);
  }
}

export async function syncRevenueCatPurchases(
  userId: string,
  checkIdentity?: () => void,
): Promise<boolean> {
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    await withRevenueCatUser(
      userId,
      async () => {
        await Purchases.syncPurchasesForResult();
        checkIdentity?.();
      },
      checkIdentity,
    );
    return true;
  } catch (error) {
    reportRevenueCatError('sync-purchases', error);
    return false;
  }
}

// With StoreKit 2 and purchases completed outside RevenueCat, the SDK does not
// observe a brand-new transaction on its own — it must be recorded explicitly,
// or backend reconciliation asks RevenueCat about a purchase it can't see yet.
// New purchases only; renewals and restores are covered by syncPurchases.
export async function recordRevenueCatPurchase(
  productId: string,
  userId: string,
  checkIdentity?: () => void,
): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    await withRevenueCatUser(
      userId,
      async () => {
        await Purchases.recordPurchase(productId);
        checkIdentity?.();
      },
      checkIdentity,
    );
    return true;
  } catch (error) {
    reportRevenueCatError('record-purchase', error);
    return false;
  }
}

export async function getAppStorefrontCountryCode(): Promise<string | null> {
  if (!configured) configureRevenueCat();
  if (!configured || Platform.OS !== 'ios') return null;
  try {
    const storefront = await Purchases.getStorefront();
    return storefront?.countryCode ?? null;
  } catch (error) {
    reportRevenueCatError('get-storefront', error);
    return null;
  }
}

export async function showAppStoreManageSubscriptions(): Promise<boolean> {
  if (!configured) configureRevenueCat();
  if (!configured || Platform.OS !== 'ios') return false;
  try {
    await Purchases.showManageSubscriptions();
    return true;
  } catch (error) {
    reportRevenueCatError('show-manage-subscriptions', error);
    return false;
  }
}
