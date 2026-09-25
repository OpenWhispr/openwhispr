import { loadAffiliateOffer } from '@/lib/affiliateOffer';
import { useAuthStore } from '../useAuthStore';
import { useUsageStore } from '../useUsageStore';
import {
  closeAffiliateOffer,
  presentAffiliateOffer,
  useAffiliateOfferStore,
} from '../useAffiliateOfferStore';

jest.mock('@/lib/affiliateOffer', () => ({ loadAffiliateOffer: jest.fn() }));
jest.mock('../useAuthStore', () => ({ useAuthStore: { getState: jest.fn() } }));
jest.mock('../useUsageStore', () => ({ useUsageStore: { getState: jest.fn() } }));

const offer = {
  campaign: 'test',
  productId: 'monthly',
  currency: 'USD',
  country: 'USA',
  regularPrice: 9.99,
  offerPrice: 7.99,
  months: 3 as const,
  expiresAt: '2027-01-01T00:00:00Z',
  redemptionUrl: 'https://apps.apple.com/redeem?ctx=offercodes&id=123&code=TEST',
};
const begin = jest.fn();
const end = jest.fn();
let owner = 'buyer';
beforeEach(() => {
  jest.clearAllMocks();
  owner = 'buyer';
  jest
    .mocked(useAuthStore.getState)
    .mockImplementation(
      () =>
        ({ user: { id: owner }, sessionCookie: 'session' }) as ReturnType<
          typeof useAuthStore.getState
        >,
    );
  jest.mocked(useUsageStore.getState).mockReturnValue({
    usage: { billingUserId: 'billing', isSubscribed: false },
    beginBillingSession: begin,
    endBillingSession: end,
  } as unknown as ReturnType<typeof useUsageStore.getState>);
  jest.mocked(loadAffiliateOffer).mockResolvedValue(offer);
});

it('presents once and resolves only after the buyer dismisses the offer', async () => {
  const pending = presentAffiliateOffer();
  expect(presentAffiliateOffer()).toBe(pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(useAffiliateOfferStore.getState()).toMatchObject({
    offer,
    identity: { userId: 'buyer', sessionCookie: 'session', billingUserId: 'billing' },
  });
  expect(begin).toHaveBeenCalledTimes(1);
  closeAffiliateOffer();
  expect(await pending).toBe(true);
  expect(useAffiliateOfferStore.getState().offer).toBeNull();
  expect(end).toHaveBeenCalledTimes(1);
});

it.each(['account change', 'onboarding unmount'])(
  'discards an offer arriving after %s',
  async (reason) => {
    let resolve!: (value: typeof offer) => void;
    jest.mocked(loadAffiliateOffer).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let current = true;
    const pending = presentAffiliateOffer(() => current);
    await new Promise<void>((done) => setImmediate(done));
    if (reason === 'account change') owner = 'other';
    else current = false;
    resolve(offer);
    expect(await pending).toBe(false);
    expect(useAffiliateOfferStore.getState().offer).toBeNull();
    expect(begin).not.toHaveBeenCalled();
  },
);

it('falls back to normal purchasing when no verified offer is available', async () => {
  jest.mocked(loadAffiliateOffer).mockResolvedValue(null);
  expect(await presentAffiliateOffer()).toBe(false);
  expect(begin).not.toHaveBeenCalled();
});

it('starts a fresh offer check after an account switch and keeps it when the old one resolves', async () => {
  let releaseOld!: (value: null) => void;
  jest.mocked(loadAffiliateOffer).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
  );
  const old = presentAffiliateOffer();
  owner = 'other';
  const current = presentAffiliateOffer();
  expect(current).not.toBe(old);
  await new Promise<void>((done) => setImmediate(done));
  releaseOld(null);
  expect(await old).toBe(false);
  expect(presentAffiliateOffer()).toBe(current);
  expect(useAffiliateOfferStore.getState().identity?.userId).toBe('other');
  closeAffiliateOffer();
  expect(await current).toBe(true);
});

it('invalidates the loader guard immediately when the offer closes', async () => {
  let isCurrent!: () => boolean;
  let release!: (value: null) => void;
  jest.mocked(loadAffiliateOffer).mockImplementation((guard) => {
    isCurrent = guard!;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = presentAffiliateOffer();
  expect(isCurrent()).toBe(true);
  closeAffiliateOffer();
  expect(isCurrent()).toBe(false);
  release(null);
  expect(await pending).toBe(false);
});
