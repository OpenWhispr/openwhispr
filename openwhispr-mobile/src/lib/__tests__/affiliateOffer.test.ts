import Purchases from 'react-native-purchases';
import { api } from '../apiClient';
import { loadAffiliateOffer, validAffiliateOffer } from '../affiliateOffer';
import { getAppStorefrontCountryCode } from '../revenuecat';
const mockAuth = { user: { id: 'buyer' }, sessionCookie: 'session' };
const mockUsage = { billingUserId: 'billing-id', isSubscribed: false };
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: mockUsage }) },
}));
jest.mock('../affiliateLink', () => ({
  getAffiliateClientConfig: () => ({ domain: 'sandbox.dub.link' }),
}));
jest.mock('../apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('../revenuecat', () => ({ getAppStorefrontCountryCode: jest.fn() }));
jest.mock('react-native-purchases', () => ({ getAppUserID: jest.fn(), getProducts: jest.fn() }));
const offer = {
  campaign: 'first-three',
  productId: 'pro.monthly',
  country: 'USA',
  currency: 'USD',
  regularPrice: 9.99,
  offerPrice: 7.99,
  months: 3,
  redemptionUrl: 'https://apps.apple.com/redeem?ctx=offercodes&id=12345&code=TESTCODE',
  expiresAt: '2099-01-01T00:00:00Z',
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user.id = 'buyer';
  mockUsage.isSubscribed = false;
  jest.mocked(getAppStorefrontCountryCode).mockResolvedValue('USA');
  jest.mocked(Purchases.getAppUserID).mockResolvedValue('billing-id');
  jest.mocked(api.post).mockResolvedValue({ data: offer });
  jest
    .mocked(Purchases.getProducts)
    .mockResolvedValue([
      { identifier: 'pro.monthly', price: 9.99, currencyCode: 'USD', subscriptionPeriod: 'P1M' },
    ] as Awaited<ReturnType<typeof Purchases.getProducts>>);
});
afterEach(() => jest.useRealTimers());
it('checks the storefront, billing identity and actual monthly product before offering the code', async () => {
  expect(await loadAffiliateOffer()).toEqual(offer);
  expect(api.post).toHaveBeenCalledWith(
    '/api/affiliate/apple-offer',
    { country: 'USA' },
    expect.objectContaining({ authenticated: false, headers: { Cookie: 'session' } }),
  );
});
it('a wrong storefront price, annual product or billing identity does not advertise an offer', async () => {
  jest
    .mocked(Purchases.getProducts)
    .mockResolvedValue([
      { identifier: 'pro.monthly', price: 10.99, currencyCode: 'USD', subscriptionPeriod: 'P1M' },
    ] as Awaited<ReturnType<typeof Purchases.getProducts>>);
  expect(await loadAffiliateOffer()).toBeNull();
  jest.mocked(Purchases.getAppUserID).mockResolvedValue('another-owner');
  expect(await loadAffiliateOffer()).toBeNull();
});
it('account changes during the product fetch discard the old account offer', async () => {
  jest.mocked(Purchases.getProducts).mockImplementation(async () => {
    mockAuth.user.id = 'another';
    return [
      { identifier: 'pro.monthly', price: 9.99, currencyCode: 'USD', subscriptionPeriod: 'P1M' },
    ] as Awaited<ReturnType<typeof Purchases.getProducts>>;
  });
  expect(await loadAffiliateOffer()).toBeNull();
});
it('a hung native lookup cannot hold the paywall indefinitely', async () => {
  jest.useFakeTimers();
  jest.mocked(getAppStorefrontCountryCode).mockImplementation(() => new Promise(() => {}));
  const pending = loadAffiliateOffer();
  await jest.advanceTimersByTimeAsync(8001);
  expect(await pending).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
it('refuses expired, mismatched-price or foreign redemption URLs', () => {
  expect(
    validAffiliateOffer(
      { ...offer, redemptionUrl: offer.redemptionUrl.replace('apps.apple.com', 'evil.test') },
      'USA',
    ),
  ).toBe(false);
  expect(validAffiliateOffer({ ...offer, expiresAt: '2020-01-01T00:00:00Z' }, 'USA')).toBe(false);
  expect(validAffiliateOffer({ ...offer, offerPrice: 8.99 }, 'USA')).toBe(false);
  expect(validAffiliateOffer({ ...offer, months: 12 }, 'USA')).toBe(false);
});
it('uses the currency precision for zero- and three-decimal storefronts', () => {
  expect(
    validAffiliateOffer(
      { ...offer, country: 'JPN', currency: 'JPY', regularPrice: 1000, offerPrice: 800 },
      'JPN',
    ),
  ).toBe(true);
  expect(
    validAffiliateOffer(
      { ...offer, country: 'KWT', currency: 'KWD', regularPrice: 3.499, offerPrice: 2.799 },
      'KWT',
    ),
  ).toBe(true);
});
