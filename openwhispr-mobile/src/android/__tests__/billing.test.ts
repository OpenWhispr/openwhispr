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
import { useUsageStore } from '@/store/useUsageStore';
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
  jest
    .mocked(Purchases.getCustomerInfo)
    .mockReset()
    .mockResolvedValue(playInfo as never);
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
it('clears stale access pending on an inactive Restore so checkout is available again', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' } });
  await expect(restoreAndroidPurchases()).resolves.toBe('none');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({
    type: 'purchased',
  });
});
it('rechecks stale active Restore data when the server finds no Play access', async () => {
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue({
    subscriptionsByProductIdentifier: { pro: { store: 'PLAY_STORE', isActive: false } },
  } as never);
  await expect(restoreAndroidPurchases()).resolves.toBe('none');
  expect(Purchases.invalidateCustomerInfoCache).toHaveBeenCalledTimes(1);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  expect(mockUsage.isSubscribed).toBe(false);
});
it('keeps Restore retryable when a fresh store check fails after server reconciliation', async () => {
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  jest.mocked(Purchases.getCustomerInfo).mockRejectedValueOnce(new Error('offline'));
  await expect(restoreAndroidPurchases()).rejects.toThrow('offline');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('access-pending');
});
it('Refresh clears expired access pending using fresh store data and permits checkout', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' } });
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue({
    subscriptionsByProductIdentifier: { pro: { store: 'PLAY_STORE', isActive: false } },
  } as never);
  await expect(refreshAndroidBillingAccess()).resolves.toMatchObject({ isSubscribed: false });
  expect(Purchases.invalidateCustomerInfoCache).toHaveBeenCalledTimes(1);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  await expect(androidPurchaseController.onPurchase(params)).resolves.toEqual({
    type: 'purchased',
  });
});
it('does not clear access pending when its fresh store check fails', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' } });
  jest.mocked(Purchases.getCustomerInfo).mockRejectedValueOnce(new Error('offline'));
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('offline');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('access-pending');
});
it('does not clear a pending payment based on an expired previous subscription during Restore', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue({
    subscriptionsByProductIdentifier: { pro: { store: 'PLAY_STORE', isActive: false } },
  } as never);
  await expect(restoreAndroidPurchases()).resolves.toBe('payment-pending');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
  expect(await androidPurchaseController.onPurchase(params)).toMatchObject({ type: 'failed' });
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('preserves the payment guard when access checks overlap before server verification', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
  await Promise.all([refreshAndroidBillingAccess(), refreshAndroidBillingAccess()]);
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('payment-pending');
  jest.mocked(Purchases.getCustomerInfo).mockResolvedValue({} as never);
  await refreshAndroidBillingAccess();
  expect(await androidPurchaseController.onPurchase(params)).toMatchObject({ type: 'failed' });
  expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
});
it('persists an unresolved payment while checking so a restart cannot turn it into stale access', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return stored.size;
    },
    clear: () => stored.clear(),
    getItem: (key) => stored.get(key) ?? null,
    key: (index) => [...stored.keys()][index] ?? null,
    removeItem: (key) => {
      stored.delete(key);
    },
    setItem: (key, value) => {
      stored.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    jest.mocked(Purchases.purchaseSubscriptionOption).mockRejectedValueOnce({ code: 'pending' });
    await androidPurchaseController.onPurchase(params);
    jest.mocked(reconcileStoreBilling).mockImplementationOnce(async () => {
      expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('checking');
      expect(JSON.parse(storage.getItem('android-billing-status-v1')!)['billing-a']).toBe(
        'payment-pending',
      );
      return mockUsage as never;
    });
    await refreshAndroidBillingAccess();
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
it('does not apply an inactive store response after the account changes', async () => {
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' } });
  jest.mocked(Purchases.getCustomerInfo).mockImplementationOnce(async () => {
    mockOwner = 'account:b';
    return { subscriptionsByProductIdentifier: {} } as never;
  });
  await expect(refreshAndroidBillingAccess()).rejects.toThrow('account changed');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('access-pending');
  expect(useAndroidBillingStatus.getState().accounts['billing-b']).toBeUndefined();
});
it('reports restored access from the server without relying on a second store response', async () => {
  jest.mocked(Purchases.restorePurchases).mockResolvedValue(playInfo as never);
  jest.mocked(reconcileStoreBilling).mockImplementationOnce(async () => {
    mockUsage.isSubscribed = true;
    mockUsage.entitlementSources.provider = true;
    mockUsage.entitlementSources.providerStore = 'play_store';
    return mockUsage as never;
  });
  await expect(restoreAndroidPurchases()).resolves.toBe('restored');
  expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe('idle');
  expect(Purchases.getCustomerInfo).not.toHaveBeenCalled();
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
it.each([
  ['access-pending', true, 'play_store', false, [], 'idle'],
  ['access-pending', false, null, true, [], 'access-pending'],
  ['access-pending', false, null, false, ['workspace'], 'access-pending'],
  ['payment-pending', true, 'play_store', false, [], 'payment-pending'],
] as const)(
  'reconciles a later usage grant for %s with provider %s, store %s, personal %s and workspaces %j',
  (status, provider, providerStore, personal, workspaceIds, expected) => {
    const stop = observeAndroidPurchaseUpdates();
    const previous = { ...useUsageStore.getState(), usage: { ...mockUsage } };
    useAndroidBillingStatus.setState({
      accounts: { 'billing-a': status, 'billing-b': 'access-pending' },
    });
    mockUsage.isSubscribed = true;
    mockUsage.entitlementSources = {
      provider,
      providerStore,
      personal,
      workspaceIds: [...workspaceIds],
    };
    const listener = jest.mocked(useUsageStore.subscribe).mock.calls.at(-1)![0];
    const cached = useUsageStore.getState();
    listener(cached, cached);
    expect(useAndroidBillingStatus.getState().accounts['billing-a']).toBe(status);
    listener(useUsageStore.getState(), previous as ReturnType<typeof useUsageStore.getState>);
    expect(useAndroidBillingStatus.getState().accounts).toEqual({
      'billing-a': expected,
      'billing-b': 'access-pending',
    });
    expect(Purchases.purchaseSubscriptionOption).not.toHaveBeenCalled();
    stop();
  },
);
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
