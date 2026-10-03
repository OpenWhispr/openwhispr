import Purchases from 'react-native-purchases';
import {
  getAppStorefrontCountryCode,
  reconcileRevenueCatPurchases,
  identifyRevenueCatUser,
  recordRevenueCatPurchase,
  showAppStoreManageSubscriptions,
} from '../revenuecat';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    logIn: jest.fn(),
    logOut: jest.fn(),
    syncPurchasesForResult: jest.fn(),
    getStorefront: jest.fn(),
    recordPurchase: jest.fn(),
    showManageSubscriptions: jest.fn(),
    setLogLevel: jest.fn(),
  },
  LOG_LEVEL: { INFO: 'INFO' },
  PURCHASES_ARE_COMPLETED_BY_TYPE: { MY_APP: 'MY_APP' },
  STOREKIT_VERSION: { STOREKIT_2: 'STOREKIT_2' },
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const mockPurchases = Purchases as jest.Mocked<typeof Purchases>;

describe('RevenueCat StoreKit helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test';
  });

  it('returns the current App Store storefront country code', async () => {
    mockPurchases.getStorefront.mockResolvedValue({ countryCode: 'DEU' });

    await expect(getAppStorefrontCountryCode()).resolves.toBe('DEU');
  });

  it('returns null when storefront lookup fails', async () => {
    mockPurchases.getStorefront.mockRejectedValue(new Error('storefront unavailable'));

    await expect(getAppStorefrontCountryCode()).resolves.toBeNull();
  });

  it('reports whether the native management sheet was presented', async () => {
    mockPurchases.showManageSubscriptions.mockResolvedValue(undefined);

    await expect(showAppStoreManageSubscriptions()).resolves.toBe(true);
  });

  it('returns false when native management cannot be presented', async () => {
    mockPurchases.showManageSubscriptions.mockRejectedValue(new Error('sheet unavailable'));

    await expect(showAppStoreManageSubscriptions()).resolves.toBe(false);
  });

  it('records a StoreKit 2 purchase with RevenueCat', async () => {
    mockPurchases.recordPurchase.mockResolvedValue({} as never);

    await expect(recordRevenueCatPurchase('pro.monthly')).resolves.toBe(true);
    expect(mockPurchases.recordPurchase).toHaveBeenCalledWith('pro.monthly');
  });

  it('returns false when recording a purchase fails', async () => {
    mockPurchases.recordPurchase.mockRejectedValue(new Error('no transaction found'));

    await expect(recordRevenueCatPurchase('pro.monthly')).resolves.toBe(false);
  });
});

it('does not sync an old account when login finishes after an account switch', async () => {
  let release!: (value: never) => void;
  let current = true;
  mockPurchases.logIn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = reconcileRevenueCatPurchases('billing-a', () => current);
  await new Promise<void>((resolve) => setImmediate(resolve));
  current = false;
  release({} as never);
  expect(await pending).toBe(false);
  expect(mockPurchases.syncPurchasesForResult).not.toHaveBeenCalled();
});
it('serializes another login behind an in-progress purchase sync', async () => {
  jest.clearAllMocks();
  let release!: (value: never) => void;
  mockPurchases.logIn.mockResolvedValue({} as never);
  mockPurchases.syncPurchasesForResult.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = reconcileRevenueCatPurchases('billing-a', () => true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = identifyRevenueCatUser('billing-b');
  expect(mockPurchases.logIn).toHaveBeenCalledTimes(1);
  release({} as never);
  expect(await pending).toBe(true);
  expect(await next).toBe(true);
  expect(mockPurchases.logIn.mock.calls.map(([id]) => id)).toEqual(['billing-a', 'billing-b']);
});

it('bounds callers behind a hung native operation without switching its identity', async () => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  let release!: (value: never) => void;
  mockPurchases.recordPurchase.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const recording = recordRevenueCatPurchase('monthly');
  await Promise.resolve();
  const next = identifyRevenueCatUser('billing-b');
  await jest.advanceTimersByTimeAsync(10001);
  expect(await recording).toBe(false);
  expect(await next).toBe(false);
  expect(mockPurchases.logIn).not.toHaveBeenCalled();
  release({} as never);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockPurchases.logIn).not.toHaveBeenCalled();
  jest.useRealTimers();
  expect(await identifyRevenueCatUser('billing-c')).toBe(true);
  expect(mockPurchases.logIn).toHaveBeenCalledWith('billing-c');
});
