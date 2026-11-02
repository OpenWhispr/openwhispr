import { reconcileStoreBilling } from '../billingReconciliation';
import { reconcileStoreBilling as reconcileAndroidStoreBilling } from '../billingReconciliation.android';
import { reconcileRevenueCatPurchases, withRevenueCatUser } from '../revenuecat';
import { reconcileMobileBilling } from '@/data/remote/billingApi';

let mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
let mockUsage = { billingUserId: 'billing-a' };
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: mockUsage }) },
}));
jest.mock('../revenuecat', () => ({
  reconcileRevenueCatPurchases: jest.fn(),
  withRevenueCatUser: jest.fn(),
}));
jest.mock('@/data/remote/billingApi', () => ({ reconcileMobileBilling: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
  mockUsage = { billingUserId: 'billing-a' };
  jest.mocked(reconcileRevenueCatPurchases).mockResolvedValue(true);
  jest.mocked(reconcileMobileBilling).mockResolvedValue({ isSubscribed: true } as never);
});

it('shares a check only within the same account and retains its original HTTP credentials', async () => {
  const first = reconcileStoreBilling();
  expect(reconcileStoreBilling()).toBe(first);
  await first;
  expect(reconcileMobileBilling).toHaveBeenCalledWith('ios', 'cookie-a');
});

it('does not share another account’s check or send its result to the new owner', async () => {
  let release!: (value: boolean) => void;
  jest.mocked(reconcileRevenueCatPurchases).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = reconcileStoreBilling();
  const rejected = expect(first).rejects.toThrow('Billing account changed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  mockAuth = { user: { id: 'b' }, sessionCookie: 'cookie-b' };
  mockUsage = { billingUserId: 'billing-b' };
  const second = reconcileStoreBilling();
  expect(second).not.toBe(first);
  release(true);
  await rejected;
  await second;
  expect(reconcileMobileBilling).toHaveBeenCalledTimes(1);
  expect(reconcileMobileBilling).toHaveBeenCalledWith('ios', 'cookie-b');
});

it('discards an HTTP response after a session change', async () => {
  jest.mocked(reconcileMobileBilling).mockImplementationOnce(async () => {
    mockAuth.sessionCookie = 'new-cookie';
    return { isSubscribed: true } as never;
  });
  await expect(reconcileStoreBilling()).rejects.toThrow('Billing account changed');
});

it('starts a fresh iOS store sync after switching away and back while requests are pending', async () => {
  const releases: (() => void)[] = [];
  jest
    .mocked(reconcileRevenueCatPurchases)
    .mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(true))));
  const first = reconcileStoreBilling();
  mockAuth = { user: { id: 'b' }, sessionCookie: 'cookie-b' };
  mockUsage = { billingUserId: 'billing-b' };
  const second = reconcileStoreBilling();
  const secondOutcome = second.catch((error: Error) => error);
  mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
  mockUsage = { billingUserId: 'billing-a' };
  const third = reconcileStoreBilling();
  const startedFresh = third !== first;
  releases.forEach((release) => release());
  await Promise.all([first, third]);
  expect(await secondOutcome).toEqual(new Error('Billing account changed'));
  expect(startedFresh).toBe(true);
  expect(reconcileRevenueCatPurchases).toHaveBeenCalledTimes(3);
});

it('checks Android access without implicitly restoring store purchases', async () => {
  jest.mocked(withRevenueCatUser).mockImplementation(async (_userId, operation, check) => {
    check?.();
    return operation();
  });
  await reconcileAndroidStoreBilling();
  expect(reconcileRevenueCatPurchases).not.toHaveBeenCalled();
  expect(withRevenueCatUser).toHaveBeenCalledWith(
    'billing-a',
    expect.any(Function),
    expect.any(Function),
  );
  expect(reconcileMobileBilling).toHaveBeenCalledWith('android', 'cookie-a');
});
