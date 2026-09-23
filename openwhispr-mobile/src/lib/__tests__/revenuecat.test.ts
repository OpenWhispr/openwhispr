import Purchases from 'react-native-purchases';
import {
  getAppStorefrontCountryCode,
  recordRevenueCatPurchase,
  showAppStoreManageSubscriptions,
} from '../revenuecat';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
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
