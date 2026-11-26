import { reconcileStoreBilling } from '../billingReconciliation';
import { reconcileRevenueCatPurchases } from '../revenuecat';
import { reconcileMobileBilling } from '@/data/remote/billingApi';

let mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
let mockUsage = { billingUserId: 'billing-a' };
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: mockUsage }) },
}));
jest.mock('../revenuecat', () => ({ reconcileRevenueCatPurchases: jest.fn() }));
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
