import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ARE_COMPLETED_BY_TYPE,
  PURCHASES_ERROR_CODE,
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
// Billing users whose link this device set and has not cleared, kept across
// launches so that leaving an account clears only a link this device made.
let linkedUsers: Set<string> | null = null;

// Written with setAttributes, never setAppsflyerID: that setter also collects
// IDFA/IDFV/IP on every call, including a clear, and PurchasesHybridCommon
// 19.0.0 ignores the configure flag that should turn this off.
const APPSFLYER_ID_ATTRIBUTE = '$appsflyerId';
// The React Native bridge drops null-valued keys, so null would clear nothing;
// RevenueCat deletes an attribute set to an empty string.
const CLEARED_ATTRIBUTE = '';
const LINKED_USERS_KEY = 'revenuecat.appsflyerLinkedUsers';
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

async function loadLinkedUsers(): Promise<Set<string>> {
  if (linkedUsers) return linkedUsers;
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(LINKED_USERS_KEY)) ?? '[]');
    linkedUsers = new Set(
      Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch (error) {
    reportRevenueCatError('linked-users', error);
    linkedUsers = new Set();
  }
  return linkedUsers;
}

async function setLinkedFromThisDevice(userId: string, linked: boolean): Promise<void> {
  const users = await loadLinkedUsers();
  if (users.has(userId) === linked) return;
  if (linked) users.add(userId);
  else users.delete(userId);
  try {
    await AsyncStorage.setItem(LINKED_USERS_KEY, JSON.stringify([...users]));
  } catch (error) {
    reportRevenueCatError('linked-users', error);
  }
}

async function linkRevenueAttribution(userId: string, id: string): Promise<void> {
  try {
    // The ID belongs to the account, not the device, and RevenueCat skips a
    // value equal to its local copy. Clearing first makes it a pending change,
    // so it reaches the server even after another device replaced or cleared it.
    await Purchases.setAttributes({ [APPSFLYER_ID_ATTRIBUTE]: CLEARED_ATTRIBUTE });
    await Purchases.setAttributes({ [APPSFLYER_ID_ATTRIBUTE]: id });
    linkedRevenueId = id;
  } catch (error) {
    reportRevenueCatError('sync-attribution', error);
    return;
  }
  await setLinkedFromThisDevice(userId, true);
}

// Clears the link of `userId`, the current SDK user. Setters only change local
// attributes, and logIn, logOut and receipt posts push them, so only withdrawing
// a link this device set asks for an immediate push. That push can be rate
// limited without rejecting, so it is not delivery proof.
async function unlinkRevenueAttribution(
  userId: string,
  { push }: { push: boolean },
): Promise<void> {
  const wasLinked = (await loadLinkedUsers()).has(userId);
  try {
    await Purchases.setAttributes({ [APPSFLYER_ID_ATTRIBUTE]: CLEARED_ATTRIBUTE });
    linkedRevenueId = null;
  } catch (error) {
    reportRevenueCatError('sync-attribution', error);
    return;
  }
  await setLinkedFromThisDevice(userId, false);
  if (!push || !wasLinked) return;
  try {
    await Purchases.syncAttributesAndOfferingsIfNeeded();
  } catch (error) {
    // The attributes go out before the offerings fetch, which fails in a
    // project without offerings; the deletion is sent either way.
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== PURCHASES_ERROR_CODE.CONFIGURATION_ERROR) {
      reportRevenueCatError('sync-attribution', error);
    }
  }
}

// Must run inside withIdentity: attribute setters target the current SDK user.
// `$appsflyerId` is the account's link, set by its consenting devices. Only an
// explicit opt-out here clears it; undecided or unknown consent leaves it alone.
// A purchase or restore posts its receipt, with the attributes, right after, so
// it links this device's ID again: another device may have changed the
// account's link since this session set it.
async function syncRevenueAttribution({ beforePost = false } = {}): Promise<void> {
  if (Platform.OS !== 'ios') return;
  // Leaving an account clears its link before logIn or logOut (when this device
  // set it), and canLinkRevenueAttribution never relinks a departed account.
  if (getAppsFlyerAttributionConsent() === 'revoked') {
    const sdkUserId = identifiedUserId ?? (await Purchases.getAppUserID());
    await unlinkRevenueAttribution(sdkUserId, { push: !beforePost });
    return;
  }
  if (!canLinkRevenueAttribution() || (linkedRevenueId && !beforePost)) return;
  // A null ID is "not readable yet"; the SDK becoming ready notifies again.
  const id = await getAppsFlyerRevenueId();
  const userId = identifiedUserId;
  if (!id || !userId || !canLinkRevenueAttribution()) return;
  await linkRevenueAttribution(userId, id);
  // Consent can be withdrawn while the setters cross the bridge. Clear it
  // before a queued purchase or restore posts, not only in a later callback.
  if (getAppsFlyerAttributionConsent() === 'revoked') {
    await unlinkRevenueAttribution(userId, { push: !beforePost });
  }
}

async function logInWithAttribution(userId: string): Promise<void> {
  if (Platform.OS === 'ios') {
    const departingUserId = await Purchases.getAppUserID();
    if (departingUserId !== userId && (await loadLinkedUsers()).has(departingUserId)) {
      // logIn pushes the departing user's attributes before switching.
      await unlinkRevenueAttribution(departingUserId, { push: false });
    }
  }
  await Purchases.logIn(userId);
  if (identifiedUserId !== userId) linkedRevenueId = null;
  identifiedUserId = userId;
  await syncRevenueAttribution();
}

async function logOutWithAttribution(): Promise<void> {
  // The SDK rejects logging out an anonymous user; there is no one to sign out.
  if (!(await Purchases.isAnonymous())) {
    if (Platform.OS === 'ios') {
      const departingUserId = await Purchases.getAppUserID();
      // logOut pushes the departing user's attributes before switching.
      if ((await loadLinkedUsers()).has(departingUserId)) {
        await unlinkRevenueAttribution(departingUserId, { push: false });
      }
    }
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
      await syncRevenueAttribution({ beforePost: true });
      // Linking can take a moment; the account must not change before posting.
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
      await syncRevenueAttribution({ beforePost: true });
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
