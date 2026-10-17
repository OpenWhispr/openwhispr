let mockOwner = 'account:a';
const mockUsage = {
  billingUserId: 'billing-a',
  isSubscribed: false,
  entitlementSources: {
    provider: false,
    providerStore: null as 'play_store' | null,
    personal: false,
    workspaceIds: [] as string[],
  },
};
const mockLoad = jest.fn(async () => ({ status: 'loaded', usage: mockUsage }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'a', isAnonymous: false } }) },
}));
jest.mock('@/store/useUsageStore', () => ({
  getUsageOwnerKey: () => mockOwner,
  useUsageStore: {
    getState: () => ({ usage: mockUsage, load: mockLoad }),
    subscribe: jest.fn(() => jest.fn()),
  },
}));
jest.mock('@/lib/revenuecat', () => ({
  withRevenueCatUser: jest.fn(async (_id, action, check) => {
    check?.();
    return action();
  }),
}));
jest.mock('@/lib/billingReconciliation', () => ({
  reconcileStoreBilling: jest.fn(async () => undefined),
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    getProducts: jest.fn(),
    purchaseSubscriptionOption: jest.fn(),
    restorePurchases: jest.fn(),
    getCustomerInfo: jest.fn(),
    invalidateCustomerInfoCache: jest.fn(async () => undefined),
    addCustomerInfoUpdateListener: jest.fn(),
    removeCustomerInfoUpdateListener: jest.fn(),
  },
  PRODUCT_CATEGORY: { SUBSCRIPTION: 'subs' },
  PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: 'cancelled', PAYMENT_PENDING_ERROR: 'pending' },
}));
import Purchases from 'react-native-purchases';
import {
  androidPurchaseController,
  restoreAndroidPurchases,
  refreshAndroidBillingAccess,
  useAndroidBillingStatus,
  observeAndroidPurchaseUpdates,
} from '../billing';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
const selected = { productId: 'pro', storeProductId: 'pro:annual', id: 'annual:trial' };
const params = {
  platform: 'android' as const,
  productId: 'pro',
  basePlanId: 'annual',
  offerId: 'trial',
};
beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'account:a';
  mockUsage.isSubscribed = false;
  mockUsage.entitlementSources = {
    provider: false,
    providerStore: null,
    personal: false,
    workspaceIds: [],
  };
  useAndroidBillingStatus.setState({ accounts: {} });
  mockLoad.mockImplementation(async () => ({ status: 'loaded', usage: mockUsage }));
  jest
    .mocked(Purchases.getProducts)
    .mockResolvedValue([{ subscriptionOptions: [selected] }] as never);
  jest.mocked(Purchases.purchaseSubscriptionOption).mockResolvedValue({} as never);
  jest.mocked(Purchases.restorePurchases).mockResolvedValue({} as never);
  jest.mocked(reconcileStoreBilling).mockResolvedValue({} as never);
});
it('purchases exactly the base plan and offer selected by the remote paywall', async () => {
  await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({
    type: 'purchased',
  });
  expect(Purchases.purchaseSubscriptionOption).toHaveBeenCalledWith(selected);
});
it('never falls back to another price or plan', async () => {
  jest
    .mocked(Purchases.getProducts)
    .mockResolvedValue([{ subscriptionOptions: [{ ...selected, id: 'annual' }] }] as never);
  expect(await androidPurchaseController.onPurchase(params)).toMatchObject({ type: 'failed' });
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('does not purchase when the signed-in account changes during product loading', async () => {
  jest.mocked(Purchases.getProducts).mockImplementation(async () => {
    mockOwner = 'account:b';
    return [{ subscriptionOptions: [selected] }] as never;
  });
  expect(await androidPurchaseController.onPurchase(params)).toMatchObject({ type: 'failed' });
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it.each(['cancelled', 'pending'])('returns %s without granting access', async (code) => {
  jest.mocked(Purchases.purchaseSubscriptionOption).mockRejectedValue({ code });
  await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({ type: code });
});
it('keeps store success when backend reconciliation is temporarily unavailable', async () => {
  jest.mocked(reconcileStoreBilling).mockRejectedValue(new Error('offline'));
  await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({
    type: 'purchased',
  });
});
it('does not claim restored access without an active backend plan', async () => {
  expect(await androidPurchaseController.onPurchaseRestore()).toMatchObject({ type: 'failed' });
  expect(Purchases.restorePurchases).toHaveBeenCalledTimes(1);
});

const playInfo = {
  subscriptionsByProductIdentifier: { pro: { store: 'PLAY_STORE', isActive: true } },
};
it('does not count a workspace subscription as a restored Play purchase', async () => {
  mockUsage.isSubscribed = true;
  mockUsage.entitlementSources.workspaceIds = ['workspace'];
  await expect(restoreAndroidPurchases()).resolves.toBe('none');
  expect(reconcileStoreBilling).not.toHaveBeenCalled();
});
it('does not report restoration after an account switch during reconciliation', async () => {
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  jest.mocked(reconcileStoreBilling).mockImplementation(async () => {
    mockOwner = 'account:b';
    return {} as never;
  });
  await expect(restoreAndroidPurchases()).rejects.toThrow('account changed');
});
it('returns pending when Play has a purchase but the backend has not verified it', async () => {
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  await expect(restoreAndroidPurchases()).resolves.toBe('pending');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('access-pending');
});
it('Refresh access retries reconciliation and clears pending only after server verification', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' } });
  jest.mocked(reconcileStoreBilling).mockRejectedValueOnce(new Error('offline'));
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('offline');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('access-pending');
  jest.mocked(reconcileStoreBilling).mockImplementation(async () => {
    mockUsage.isSubscribed = true;
    mockUsage.entitlementSources.provider = true;
    mockUsage.entitlementSources.providerStore = 'play_store';
    return mockUsage as never;
  });
  await refreshAndroidBillingAccess();
  expect(reconcileStoreBilling).toHaveBeenCalledTimes(2);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
});
it.each([undefined, 'idle'] as const)(
  'keeps an expired plan eligible for checkout when its prior purchase status is %s',
  async (status) => {
    useAndroidBillingStatus.setState({ accounts: status ? { 'billing-a': status } : {} });
    mockUsage.isSubscribed = true;
    mockUsage.entitlementSources.provider = true;
    mockUsage.entitlementSources.providerStore = 'play_store';
    mockLoad.mockImplementation(async () => {
      mockUsage.isSubscribed = false;
      mockUsage.entitlementSources.provider = false;
      mockUsage.entitlementSources.providerStore = null;
      return { status: 'loaded', usage: mockUsage };
    });

    await expect(refreshAndroidBillingAccess()).resolves.toMatchObject({ isSubscribed: false });
    expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe(status);
    expect(reconcileStoreBilling).not.toHaveBeenCalled();
    await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({
      type: 'purchased',
    });
    expect(Purchases.purchaseSubscriptionOption).toHaveBeenCalledWith(selected);
  },
);
it('does not create a pending purchase when a generic access refresh fails', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'idle' } });
  mockLoad.mockRejectedValueOnce(new Error('offline'));
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('offline');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('rechecks a completed pending payment and deduplicates customer updates during verification', async () => {
  jest.mocked(Purchases.purchaseSubscriptionOption).mockRejectedValue({ code: 'pending' });
  await androidPurchaseController.onPurchase(params);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue(playInfo as never);
  const stop = observeAndroidPurchaseUpdates();
  const listener = jest.mocked(Purchases.addCustomerInfoUpdateListener).mock.calls[0][0];
  listener(playInfo as never);
  listener(playInfo as never);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(Purchases.getCustomerInfo).toHaveBeenCalledTimes(2);
  expect(reconcileStoreBilling).toHaveBeenCalledTimes(2);
  stop();
  expect(Purchases.removeCustomerInfoUpdateListener).toHaveBeenCalledWith(listener);
});

it('does not create a second purchase while payment is pending', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  expect(await androidPurchaseController.onPurchase(params)).toMatchObject({ type: 'failed' });
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('refreshes stale store data without treating missing entitlement as cancelled payment', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue({} as never);
  await refreshAndroidBillingAccess();
  expect(Purchases.invalidateCustomerInfoCache).toHaveBeenCalledTimes(1);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
  expect(reconcileStoreBilling).not.toHaveBeenCalled();
});
it('preserves unresolved payment on empty restore and explains recovery', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  expect(await restoreAndroidPurchases()).toBe('payment-pending');
  expect(await androidPurchaseController.onPurchaseRestore()).toMatchObject({
    type: 'failed',
    error: expect.stringContaining('Check Google Play'),
  });
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('preserves unresolved payment when the fresh store query fails', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  jest.mocked(Purchases.getCustomerInfo).mockRejectedValueOnce(new Error('offline'));
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('offline');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
});
it('stops a refresh if the account changes while clearing the store cache', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  jest.mocked(Purchases.invalidateCustomerInfoCache).mockImplementationOnce(async () => {
    mockOwner = 'account:b';
  });
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('account changed');
  expect(Purchases.getCustomerInfo).not.toHaveBeenCalled();
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
});
it('fresh server proof clears pending even when cached store information would be inactive', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  mockUsage.isSubscribed = true;
  mockUsage.entitlementSources.provider = true;
  mockUsage.entitlementSources.providerStore = 'play_store';
  await refreshAndroidBillingAccess();
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  expect(Purchases.getCustomerInfo).not.toHaveBeenCalled();
});
it('retries a completion update that arrives during an older inactive store response', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  let resolve!: (info: never) => void;
  jest.mocked(Purchases.getCustomerInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue(playInfo as never);
  const stop = observeAndroidPurchaseUpdates();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  jest.mocked(Purchases.addCustomerInfoUpdateListener).mock.calls[0][0](playInfo as never);
  resolve({ subscriptionsByProductIdentifier: {} } as never);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(Purchases.getCustomerInfo).toHaveBeenCalledTimes(2);
  expect(reconcileStoreBilling).toHaveBeenCalledTimes(1);
  stop();
});
