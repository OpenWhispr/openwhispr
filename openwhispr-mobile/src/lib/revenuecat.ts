import { Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ARE_COMPLETED_BY_TYPE,
  STOREKIT_VERSION,
} from 'react-native-purchases';
import { Sentry } from '@/lib/sentry';
import {
  getAppsFlyerAttributionConsent,
  getAppsFlyerRevenueId,
  subscribeAppsFlyerAttribution,
} from '@/lib/appsflyer';

let configured = false;
// The billing user this session logged the SDK in as, and the one the app
// currently wants. They differ while a sign-out or account switch is pending.
let identifiedUserId: string | null = null;
let requestedUserId: string | null = null;
// The identifier this session attached to identifiedUserId, if any.
let linkedRevenueId: string | null = null;
let identityQueue: Promise<unknown> = Promise.resolve();

const IDENTITY_CALL_TIMEOUT_MS = 10_000;
// Restoring purchases can take far longer than a login on a slow network or a
// long purchase history, and reconciliation must not give up on it early.
const PURCHASE_SYNC_TIMEOUT_MS = 60_000;
// Longer than any one call's deadline, so ordinary queueing behind a sync never fails.
const IDENTITY_QUEUE_WAIT_MS = 90_000;

// Identity changes run one at a time and in order, so the last login or logout
// always wins; queued work is never skipped. A call's own deadline starts when it
// runs, so ordinary queueing never fails it, and a separate cap on the wait
// releases callers stuck behind a native call that never settles. Native calls
// cannot be cancelled: a released call still runs, and holds the lock until it
// settles.
function withIdentity<T>(
  operation: () => Promise<T>,
  timeoutMs = IDENTITY_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tooLong = () => reject(new Error('RevenueCat identity call timed out'));
    const waiting = setTimeout(tooLong, IDENTITY_QUEUE_WAIT_MS);
    const run = () => {
      clearTimeout(waiting);
      const timer = setTimeout(tooLong, timeoutMs);
      const work = Promise.resolve()
        .then(operation)
        .finally(() => clearTimeout(timer));
      work.then(resolve, reject);
      return work;
    };
    identityQueue = identityQueue.then(run).catch(() => {});
  });
}

function canLinkRevenueAttribution(): boolean {
  return (
    identifiedUserId !== null &&
    identifiedUserId === requestedUserId &&
    getAppsFlyerAttributionConsent() === 'granted'
  );
}

// A definite opt-out, or a signed-in user who has since left (sign-out or an
// account switch still queued, or a sign-out the SDK failed to complete).
function revenueAttributionWithdrawn(): boolean {
  return (
    getAppsFlyerAttributionConsent() === 'revoked' ||
    (identifiedUserId !== null && identifiedUserId !== requestedUserId)
  );
}

async function linkRevenueAttribution(id: string): Promise<void> {
  if (linkedRevenueId === id) return;
  try {
    // Device identifiers are collected only here, with consent; automatic
    // collection is off so clearing the ID never sends them.
    await Purchases.collectDeviceIdentifiers();
    await Purchases.setAppsflyerID(id);
    linkedRevenueId = id;
  } catch (error) {
    reportRevenueCatError('sync-attribution', error);
  }
}

// Setters only change local attributes. logIn, logOut and every receipt post
// push them, so only a withdrawal of a linked ID asks for an immediate push.
// That push can be rate limited without rejecting, so it is not delivery proof.
async function unlinkRevenueAttribution({ push }: { push: boolean }): Promise<void> {
  const wasLinked = linkedRevenueId !== null;
  try {
    await Purchases.setAppsflyerID(null);
    linkedRevenueId = null;
    if (push && wasLinked) await Purchases.syncAttributesAndOfferingsIfNeeded();
  } catch (error) {
    reportRevenueCatError('sync-attribution', error);
  }
}

// Must run inside withIdentity: attribute setters target the current SDK user.
async function syncRevenueAttribution(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (revenueAttributionWithdrawn()) {
    await unlinkRevenueAttribution({ push: true });
    return;
  }
  // Undecided consent, or a user this session has not logged in: keep what the
  // SDK user already has rather than treating "unknown" as a withdrawal.
  if (!canLinkRevenueAttribution() || linkedRevenueId) return;
  // A null ID is "not readable yet"; a started session notifies again.
  const id = await getAppsFlyerRevenueId();
  if (!id || !canLinkRevenueAttribution()) return;
  await linkRevenueAttribution(id);
  // Consent can be withdrawn while the setters cross the bridge. Clear it
  // before a queued purchase or restore posts, not only in a later callback.
  if (revenueAttributionWithdrawn()) await unlinkRevenueAttribution({ push: true });
}

// An anonymous SDK user is never linked, so only a signed-in one needs clearing.
async function isSignedInSdkUserOtherThan(userId: string | null): Promise<boolean> {
  return (await Purchases.getAppUserID()) !== userId && !(await Purchases.isAnonymous());
}

async function logInWithAttribution(userId: string): Promise<void> {
  if (Platform.OS === 'ios' && (await isSignedInSdkUserOtherThan(userId))) {
    // logIn pushes the departing user's attributes before switching.
    await unlinkRevenueAttribution({ push: false });
  }
  await Purchases.logIn(userId);
  if (identifiedUserId !== userId) linkedRevenueId = null;
  identifiedUserId = userId;
  await syncRevenueAttribution();
}

async function logOutWithAttribution(): Promise<void> {
  // The SDK rejects logging out an anonymous user; there is no one to sign out.
  if (await isSignedInSdkUserOtherThan(null)) {
    // logOut pushes the departing user's attributes before switching.
    if (Platform.OS === 'ios') await unlinkRevenueAttribution({ push: false });
    await Purchases.logOut();
  }
  identifiedUserId = null;
  linkedRevenueId = null;
}

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

// Observer mode: Superwall/StoreKit completes purchases; RevenueCat only observes
// transactions for analytics and never gates access. Without a key it is a no-op,
// so builds without RevenueCat configured are unaffected.
export function configureRevenueCat(): void {
  if (configured) return;
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) return;

  try {
    Purchases.configure({
      apiKey,
      purchasesAreCompletedBy: {
        type: PURCHASES_ARE_COMPLETED_BY_TYPE.MY_APP,
        storeKitVersion: STOREKIT_VERSION.STOREKIT_2,
      },
      automaticDeviceIdentifierCollectionEnabled: false,
    });
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.INFO);
    configured = true;
    if (Platform.OS === 'ios') {
      const refresh = () => {
        withIdentity(syncRevenueAttribution).catch((error) => {
          reportRevenueCatError('sync-attribution', error);
        });
      };
      subscribeAppsFlyerAttribution(refresh);
      refresh();
    }
  } catch (error) {
    reportRevenueCatError('configure', error);
  }
}

export async function identifyRevenueCatUser(userId: string): Promise<boolean> {
  requestedUserId = userId;
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    await withIdentity(() => logInWithAttribution(userId));
    return true;
  } catch (error) {
    reportRevenueCatError('identify', error);
    return false;
  }
}

export async function resetRevenueCatUser(): Promise<void> {
  requestedUserId = null;
  if (!configured) return;
  try {
    await withIdentity(logOutWithAttribution);
  } catch (error) {
    reportRevenueCatError('reset', error);
  }
}

// Keep the login and sync together: a sign-out or another account's login must
// not change the SDK owner halfway through restoring a purchase.
export async function reconcileRevenueCatPurchases(
  billingUserId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  requestedUserId = billingUserId;
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    return await withIdentity(async () => {
      if (!isCurrent()) return false;
      await logInWithAttribution(billingUserId);
      if (!isCurrent()) return false;
      await Purchases.syncPurchasesForResult();
      return isCurrent();
    }, PURCHASE_SYNC_TIMEOUT_MS);
  } catch (error) {
    reportRevenueCatError('reconcile-purchases', error);
    return false;
  }
}

// With StoreKit 2 and purchases completed outside RevenueCat, the SDK does not
// observe a brand-new transaction on its own — it must be recorded explicitly,
// or backend reconciliation asks RevenueCat about a purchase it can't see yet.
// New purchases only; renewals and restores are covered by syncPurchases.
export async function recordRevenueCatPurchase(productId: string): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  if (!configured) configureRevenueCat();
  if (!configured) return false;
  try {
    await withIdentity(async () => {
      await syncRevenueAttribution();
      await Purchases.recordPurchase(productId);
    });
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
