jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'buyer' }, sessionCookie: 'session' }) },
}));
jest.mock('../apiClient', () => ({ api: { post: jest.fn() } }));
import { AppState, Linking } from 'react-native';
import Purchases from 'react-native-purchases';
import {
  createAffiliatePaywallSession,
  CREATOR_INPUT_KEY,
  CREATOR_PLAN_KEY,
  CREATOR_PRODUCT_KEY,
  CREATOR_TOKEN_KEY,
} from '../affiliatePaywall';
import { loadAffiliateOffer } from '../affiliateOffer';
import { getTrackingAuthorizationStatus } from '../trackingTransparency';
let mockIdentity: { userId: string; sessionCookie: string; billingUserId: string } | null = {
  userId: 'buyer',
  sessionCookie: 'session',
  billingUserId: 'billing',
};
let mockIdentityCurrent = true;
const mockUsage = {
  usage: { isSubscribed: false },
  beginBillingSession: jest.fn(),
  endBillingSession: jest.fn(),
  load: jest.fn(),
};
const mockConfig = { config: { usageAnalyticsEnabled: true } };
const mockCandidate = {
  link: '',
  saved: false,
  checking: false,
  hydrate: jest.fn(),
  bindSession: jest.fn(),
  edit: jest.fn(),
  prepare: jest.fn(),
};
jest.mock('../billingIdentity', () => ({
  getBillingIdentity: () => mockIdentity,
  isBillingIdentityCurrent: () => mockIdentityCurrent,
}));
jest.mock('@/store/useAffiliateStore', () => ({
  useAffiliateStore: { getState: () => mockCandidate },
}));
jest.mock('@/store/useUsageStore', () => ({ useUsageStore: { getState: () => mockUsage } }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: () => mockConfig } }));
jest.mock('../affiliateLink', () => ({
  ...jest.requireActual('../affiliateLink'),
  getAffiliateClientConfig: () => ({ domain: 'creators.example.com' }),
}));
jest.mock('../affiliateOffer', () => ({
  ...jest.requireActual('../affiliateOffer'),
  loadAffiliateOffer: jest.fn(),
}));
jest.mock('../trackingTransparency', () => ({ getTrackingAuthorizationStatus: jest.fn() }));
jest.mock('../revenuecat', () => ({ getAppStorefrontCountryCode: jest.fn(async () => 'USA') }));
jest.mock('../billingReconciliation', () => ({ reconcileStoreBilling: jest.fn(async () => {}) }));
jest.mock('react-native-purchases', () => ({ getAppUserID: jest.fn(), getProducts: jest.fn() }));
const offer = {
  campaign: 'fixture',
  productId: 'monthly',
  country: 'USA',
  currency: 'USD',
  regularPrice: 9.99,
  offerPrice: 7.99,
  months: 3 as const,
  redemptionUrl: 'https://apps.apple.com/redeem?ctx=offercodes&id=123&code=TEST',
  expiresAt: '2099-01-01T00:00:00Z',
};
const apply = () => ({
  name: 'creatorCodeApply',
  variables: {
    [CREATOR_INPUT_KEY]: 'demo',
    [CREATOR_PLAN_KEY]: 1,
    [CREATOR_PRODUCT_KEY]: 'monthly',
  },
});
function redeem(data: Record<string, unknown>) {
  return {
    name: 'creatorOfferRedeem',
    variables: {
      [CREATOR_PLAN_KEY]: 1,
      [CREATOR_PRODUCT_KEY]: 'monthly',
      [CREATOR_TOKEN_KEY]: data.offerToken,
      'callbacks.creatorCodeApply.data.priceText': data.priceText,
      'callbacks.creatorCodeApply.data.renewalText': data.renewalText,
    },
  };
}
let sessions: ReturnType<typeof createAffiliatePaywallSession>[] = [];
const start = () => {
  const session = createAffiliatePaywallSession(() => true, jest.fn());
  sessions.push(session);
  return session;
};
beforeEach(() => {
  jest.clearAllMocks();
  mockIdentityCurrent = true;
  mockIdentity = { userId: 'buyer', sessionCookie: 'session', billingUserId: 'billing' };
  mockConfig.config.usageAnalyticsEnabled = true;
  mockUsage.usage.isSubscribed = false;
  Object.assign(mockCandidate, { link: '', saved: false, checking: false });
  mockCandidate.edit.mockImplementation(async (link) => {
    mockCandidate.link = link;
  });
  mockCandidate.prepare.mockImplementation(async () => {
    mockCandidate.saved = true;
    return true;
  });
  jest.mocked(loadAffiliateOffer).mockResolvedValue(offer);
  jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue('authorized');
  jest.mocked(Purchases.getAppUserID).mockResolvedValue('billing');
  jest
    .mocked(Purchases.getProducts)
    .mockResolvedValue([
      { identifier: 'monthly', price: 9.99, currencyCode: 'USD', subscriptionPeriod: 'P1M' },
    ] as Awaited<ReturnType<typeof Purchases.getProducts>>);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
});
afterEach(() => {
  sessions.forEach((s) => s.close());
  sessions = [];
  jest.useRealTimers();
});
it('only returns display strings and a presentation token after explicit attribution and verified allocation', async () => {
  const result = await start().handle(apply());
  expect(result).toMatchObject({
    status: 'success',
    data: {
      priceText: '$7.99',
      renewalText: expect.stringContaining('$9.99'),
      offerToken: expect.any(String),
    },
  });
  expect(Object.keys(result.data!).sort()).toEqual(['offerToken', 'priceText', 'renewalText']);
  expect(JSON.stringify(result)).not.toContain('TEST');
  expect(JSON.stringify(result)).not.toContain('apps.apple.com');
  expect(mockCandidate.prepare).toHaveBeenCalledTimes(1);
  expect(loadAffiliateOffer).toHaveBeenCalledTimes(1);
  expect(Linking.openURL).not.toHaveBeenCalled();
});
it.each([0, '1', null])(
  'rejects non-monthly or malformed selected plan %s without a claim',
  async (selected) => {
    const request = apply();
    request.variables[CREATOR_PLAN_KEY] = selected as number;
    expect((await start().handle(request)).status).toBe('failure');
    expect(mockCandidate.prepare).not.toHaveBeenCalled();
    expect(loadAffiliateOffer).not.toHaveBeenCalled();
  },
);
it.each(['denied', 'notDetermined'] as const)(
  'preserves ordinary purchase by refusing creator work when consent is %s',
  async (status) => {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue(status);
    expect((await start().handle(apply())).status).toBe('failure');
    expect(mockCandidate.edit).not.toHaveBeenCalled();
    expect(loadAffiliateOffer).not.toHaveBeenCalled();
  },
);
it('refuses a different saved creator instead of treating new text as saved', async () => {
  mockCandidate.saved = true;
  mockCandidate.link = 'first';
  expect((await start().handle(apply())).status).toBe('failure');
  expect(mockCandidate.edit).not.toHaveBeenCalled();
  expect(loadAffiliateOffer).not.toHaveBeenCalled();
});
it.each(['dismissal', 'account switch'])('drops an offer arriving after %s', async (reason) => {
  let resolve!: (value: typeof offer) => void;
  jest.mocked(loadAffiliateOffer).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const session = start();
  const pending = session.handle(apply());
  await new Promise<void>((done) => setImmediate(done));
  if (reason === 'dismissal') session.close();
  else mockIdentityCurrent = false;
  resolve(offer);
  expect((await pending).status).toBe('failure');
  expect(Linking.openURL).not.toHaveBeenCalled();
});
it('ties redemption to the exact displayed private offer and refuses a later presentation', async () => {
  const first = start();
  const result = await first.handle(apply());
  expect((await start().handle(redeem(result.data!))).status).toBe('failure');
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect((await first.handle(redeem(result.data!))).status).toBe('success');
  expect(Linking.openURL).toHaveBeenCalledWith(offer.redemptionUrl);
  expect(mockUsage.beginBillingSession).toHaveBeenCalledTimes(1);
});
it('refuses changed displayed price and a changed catalog before opening Apple', async () => {
  const session = start();
  const result = await session.handle(apply());
  expect((await session.handle(redeem({ ...result.data, priceText: '$1.00' }))).status).toBe(
    'failure',
  );
  jest.mocked(Purchases.getProducts).mockResolvedValue([]);
  expect((await session.handle(redeem(result.data!))).status).toBe('failure');
  expect(Linking.openURL).not.toHaveBeenCalled();
});
it('does not return success for a different monthly product', async () => {
  jest.mocked(loadAffiliateOffer).mockResolvedValue({ ...offer, productId: 'other' });
  expect((await start().handle(apply())).status).toBe('failure');
});
it('bounds a hung preparation and prevents its late result from allocating', async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  mockCandidate.hydrate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = start().handle(apply());
  await jest.advanceTimersByTimeAsync(20_001);
  expect((await pending).status).toBe('failure');
  finish();
  await jest.advanceTimersByTimeAsync(1);
  expect(mockCandidate.prepare).not.toHaveBeenCalled();
  expect(loadAffiliateOffer).not.toHaveBeenCalled();
});

it('binds billing identity after usage loads without replacing the opening account', async () => {
  mockIdentity = null;
  const session = start();
  expect((await session.handle(apply())).status).toBe('failure');
  mockIdentity = { userId: 'buyer', sessionCookie: 'session', billingUserId: 'billing' };
  expect((await session.handle(apply())).status).toBe('success');
});
it('seeds Account display values while keeping redemption private and avoiding another allocation', async () => {
  const session = createAffiliatePaywallSession(() => true, jest.fn(), offer);
  sessions.push(session);
  expect(Object.keys(session.initialParams).sort()).toEqual([
    'creator_offer_price',
    'creator_offer_ready',
    'creator_offer_renewal',
    'creator_offer_token',
  ]);
  expect(JSON.stringify(session.initialParams)).not.toContain('apps.apple.com');
  const request = {
    name: 'creatorOfferRedeem',
    variables: {
      [CREATOR_PLAN_KEY]: 1,
      [CREATOR_PRODUCT_KEY]: 'monthly',
      ...Object.fromEntries(
        Object.entries(session.initialParams).map(([key, value]) => [`params.${key}`, value]),
      ),
    },
  };
  expect((await session.handle(request)).status).toBe('success');
  expect(loadAffiliateOffer).not.toHaveBeenCalled();
  expect(mockCandidate.prepare).not.toHaveBeenCalled();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect((await session.handle(request)).status).toBe('failure');
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
});
it('does not display an allocation after tracking permission is revoked', async () => {
  jest.mocked(loadAffiliateOffer).mockImplementationOnce(async () => {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue('denied');
    return offer;
  });
  expect((await start().handle(apply())).status).toBe('failure');
});

it('matches the same saved trusted creator key despite tracking query and hash', async () => {
  mockCandidate.saved = true;
  mockCandidate.link = 'https://creators.example.com/demo?utm_source=creator#offer';
  expect((await start().handle(apply())).status).toBe('success');
  expect(mockCandidate.edit).not.toHaveBeenCalled();
  expect(mockCandidate.link).toContain('?utm_source=creator#offer');
});
