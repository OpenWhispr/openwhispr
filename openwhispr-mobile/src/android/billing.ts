import { create } from 'zustand';
import { AppState } from 'react-native';
import Purchases, { PRODUCT_CATEGORY, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import type { CustomerInfo } from 'react-native-purchases';
import type { CustomPurchaseControllerContext } from 'expo-superwall';
import type { UsageInfo } from '@/data/remote/usageApi';
import { useAuthStore } from '@/store/useAuthStore';
import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';
import { withRevenueCatUser } from '@/lib/revenuecat';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { Sentry } from '@/lib/sentry';

type BillingStatus = 'checking' | 'payment-pending' | 'access-pending' | 'idle';
const STATUS_KEY = 'android-billing-status-v1';
function savedStatus(): Record<string, BillingStatus> {
  try {
    const value = JSON.parse(localStorage.getItem(STATUS_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry) =>
        ['payment-pending', 'access-pending', 'idle'].includes(String(entry[1])),
      ),
    ) as Record<string, BillingStatus>;
  } catch {
    return {};
  }
}
export const useAndroidBillingStatus = create<{ accounts: Record<string, BillingStatus> }>(() => ({
  accounts: savedStatus(),
}));
function setStatus(billingId: string, status: BillingStatus): void {
  const accounts = { ...useAndroidBillingStatus.getState().accounts, [billingId]: status };
  useAndroidBillingStatus.setState({ accounts });
  // Only public billing UUIDs and state are persisted, never auth tokens or purchase receipts.
  try {
    localStorage.setItem(
      STATUS_KEY,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(accounts).map(([id, state]) => [
            id,
            state === 'checking' ? 'access-pending' : state,
          ]),
        ),
      ),
    );
  } catch {
    /* The current screen still exposes retry if storage is unavailable. */
  }
}

type BillingAccount = { owner: string; billingId: string; check: () => void };
async function currentBillingAccount(): Promise<BillingAccount> {
  const owner = getUsageOwnerKey();
  if (!owner || useAuthStore.getState().user?.isAnonymous)
    throw new Error('Sign in to manage your plan.');
  const result = await useUsageStore.getState().load(true);
  if (result.status === 'failed') throw result.error;
  if (result.status !== 'loaded' || getUsageOwnerKey() !== owner)
    throw new Error('Your account changed. Please try again.');
  const billingId = result.usage.billingUserId;
  if (!billingId) throw new Error('Could not load your billing account. Try again.');
  const check = () => {
    if (getUsageOwnerKey() !== owner || useUsageStore.getState().usage?.billingUserId !== billingId)
      throw new Error('Your account changed. Please try again.');
  };
  check();
  return { owner, billingId, check };
}

let storeActionActive = false;
async function accountOperation<T>(
  account: BillingAccount,
  operation: () => Promise<T>,
): Promise<T> {
  if (storeActionActive) throw new Error('A store action is already in progress.');
  storeActionActive = true;
  try {
    return await withRevenueCatUser(account.billingId, operation, account.check);
  } finally {
    storeActionActive = false;
  }
}
function hasPlaySubscription(info: CustomerInfo): boolean {
  return Object.values(info.subscriptionsByProductIdentifier ?? {}).some(
    (subscription) => subscription.store === 'PLAY_STORE' && subscription.isActive,
  );
}
function hasBackendPlayAccess(usage: UsageInfo): boolean {
  return (
    usage.isSubscribed &&
    usage.entitlementSources?.provider === true &&
    usage.entitlementSources.providerStore === 'play_store'
  );
}

async function refreshAccountAccess(account: BillingAccount): Promise<UsageInfo> {
  account.check();
  setStatus(account.billingId, 'checking');
  try {
    await reconcileStoreBilling();
    account.check();
    const result = await useUsageStore.getState().load(true);
    account.check();
    if (result.status === 'failed') throw result.error;
    if (result.status !== 'loaded') throw new Error('Access could not be refreshed. Try again.');
    setStatus(account.billingId, hasBackendPlayAccess(result.usage) ? 'idle' : 'access-pending');
    return result.usage;
  } catch (error) {
    setStatus(account.billingId, 'access-pending');
    throw error;
  }
}
export async function refreshAndroidBillingAccess(): Promise<UsageInfo> {
  const account = await currentBillingAccount();
  const currentUsage = useUsageStore.getState().usage!;
  if (hasBackendPlayAccess(currentUsage)) {
    setStatus(account.billingId, 'idle');
    return currentUsage;
  }
  const status = useAndroidBillingStatus.getState().accounts[account.billingId];
  // The account load already refreshed access. Only an unresolved purchase needs reconciliation.
  if (status !== 'payment-pending' && status !== 'access-pending') return currentUsage;
  if (status === 'payment-pending') {
    const info = await withRevenueCatUser(
      account.billingId,
      async () => {
        await Purchases.invalidateCustomerInfoCache();
        account.check();
        return Purchases.getCustomerInfo();
      },
      account.check,
    );
    account.check();
    if (!hasPlaySubscription(info)) return useUsageStore.getState().usage!;
  }
  return refreshAccountAccess(account);
}

export async function restoreAndroidPurchases(): Promise<
  'restored' | 'pending' | 'payment-pending' | 'none'
> {
  const account = await currentBillingAccount();
  const info = await accountOperation(account, async () => {
    const restored = await Purchases.restorePurchases();
    account.check();
    return restored;
  });
  account.check();
  if (!hasPlaySubscription(info))
    return useAndroidBillingStatus.getState().accounts[account.billingId] === 'payment-pending'
      ? 'payment-pending'
      : 'none';
  const usage = await refreshAccountAccess(account);
  account.check();
  return hasBackendPlayAccess(usage) ? 'restored' : 'pending';
}

// CustomerInfo is only a signal to retry server verification; it never grants access.
export function observeAndroidPurchaseUpdates(): () => void {
  let refreshing = false;
  let disposed = false;
  let retryPending = false;
  let lastSubscriptionSignature = '';
  const retry = () => {
    const billingId = useUsageStore.getState().usage?.billingUserId;
    if (!billingId || refreshing || disposed) return;
    const status = useAndroidBillingStatus.getState().accounts[billingId];
    if (status !== 'payment-pending' && status !== 'access-pending') return;
    refreshing = true;
    void (async () => {
      const account = await currentBillingAccount();
      if (hasBackendPlayAccess(useUsageStore.getState().usage!)) {
        setStatus(account.billingId, 'idle');
        return;
      }
      const info = await withRevenueCatUser(
        account.billingId,
        () => Purchases.getCustomerInfo(),
        account.check,
      );
      account.check();
      if (!disposed && hasPlaySubscription(info)) await refreshAccountAccess(account);
    })()
      .catch((error) => {
        Sentry.captureException(error, {
          tags: { feature: 'android-billing', operation: 'pending-purchase' },
        });
      })
      .finally(() => {
        refreshing = false;
        if (retryPending) {
          retryPending = false;
          retry();
        }
      });
  };
  const listener = (info: CustomerInfo) => {
    if (!hasPlaySubscription(info)) return;
    const signature = JSON.stringify(
      Object.entries(info.subscriptionsByProductIdentifier ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
    if (signature === lastSubscriptionSignature) return;
    lastSubscriptionSignature = signature;
    if (refreshing) retryPending = true;
    else retry();
  };
  Purchases.addCustomerInfoUpdateListener(listener);
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') retry();
  });
  const unsubscribe = useUsageStore.subscribe((state, previous) => {
    if (state.usage?.billingUserId !== previous.usage?.billingUserId) retry();
  });
  retry();
  return () => {
    disposed = true;
    foreground.remove();
    unsubscribe();
    Purchases.removeCustomerInfoUpdateListener(listener);
  };
}

export const androidPurchaseController: CustomPurchaseControllerContext = {
  async onPurchase(params) {
    if (params.platform !== 'android') return { type: 'failed', error: 'Unsupported store.' };
    let account: BillingAccount | undefined;
    try {
      account = await currentBillingAccount();
      const pending = useAndroidBillingStatus.getState().accounts[account.billingId];
      if (pending && pending !== 'idle')
        throw new Error(
          'A purchase is awaiting verification. Use Refresh access before trying again.',
        );
      if (useUsageStore.getState().usage?.isSubscribed)
        throw new Error(
          'This account already has access. Manage your existing subscription to make changes.',
        );
      const selectedAccount = account;
      await accountOperation(selectedAccount, async () => {
        const products = await Purchases.getProducts(
          [params.productId],
          PRODUCT_CATEGORY.SUBSCRIPTION,
        );
        selectedAccount.check();
        const optionId = params.offerId
          ? `${params.basePlanId}:${params.offerId}`
          : params.basePlanId;
        const matches = products.flatMap((product) =>
          (product.subscriptionOptions ?? []).filter(
            (option) =>
              option.productId === params.productId &&
              option.storeProductId === `${params.productId}:${params.basePlanId}` &&
              option.id === optionId,
          ),
        );
        if (matches.length !== 1)
          throw new Error('This subscription offer is unavailable. Please try again later.');
        await Purchases.purchaseSubscriptionOption(matches[0]);
      });
    } catch (error) {
      const problem = error as { code?: string; userCancelled?: boolean; message?: string };
      if (problem.userCancelled || problem.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR)
        return { type: 'cancelled' };
      if (problem.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
        if (account) setStatus(account.billingId, 'payment-pending');
        return { type: 'pending' };
      }
      return { type: 'failed', error: problem.message || 'Purchase could not be completed.' };
    }
    // Store success remains success even if the account changes or verification is offline.
    setStatus(account.billingId, 'access-pending');
    void refreshAccountAccess(account).catch((error) => {
      Sentry.captureException(error, {
        tags: { feature: 'android-billing', operation: 'reconcile' },
      });
    });
    return { type: 'purchased' };
  },
  async onPurchaseRestore() {
    try {
      const result = await restoreAndroidPurchases();
      if (result === 'restored') return { type: 'restored' };
      return {
        type: 'failed',
        error:
          result === 'payment-pending'
            ? 'Your earlier payment is still unresolved. Check Google Play before starting another purchase. Refresh access after the payment completes, or contact support if it was cancelled.'
            : result === 'pending'
              ? 'Google Play purchase found. Access verification is pending; use Refresh access to retry.'
              : 'No active Google Play purchase was restored. Existing access is unchanged.',
      };
    } catch (error) {
      return { type: 'failed', error: (error as Error).message };
    }
  },
};
