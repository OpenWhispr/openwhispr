import { recordPurchaseForBilling } from '../recordPurchaseForBilling.android';
import { recordRevenueCatPurchase } from '@/lib/revenuecat.android';

let mockOwner: string | null = 'owner-a';
let mockBillingId: string | null = 'billing-a';
jest.mock('@/store/useUsageStore', () => ({
  getUsageOwnerKey: () => mockOwner,
  useUsageStore: {
    getState: () => ({ usage: mockBillingId ? { billingUserId: mockBillingId } : null }),
  },
}));
jest.mock('@/lib/revenuecat.android', () => ({ recordRevenueCatPurchase: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'owner-a';
  mockBillingId = 'billing-a';
  jest.mocked(recordRevenueCatPurchase).mockResolvedValue(false);
});

it('retains Android billing-owner arguments', async () => {
  await recordPurchaseForBilling('monthly');
  expect(recordRevenueCatPurchase).toHaveBeenCalledWith(
    'monthly',
    'billing-a',
    expect.any(Function),
  );
});

it.each(['owner', 'billing'] as const)(
  'skips recording without the %s identity',
  async (missing) => {
    if (missing === 'owner') mockOwner = null;
    else mockBillingId = null;
    await recordPurchaseForBilling('monthly');
    expect(recordRevenueCatPurchase).not.toHaveBeenCalled();
  },
);

it.each(['owner', 'billing'] as const)('retains the supplied %s change guard', async (changed) => {
  await recordPurchaseForBilling('monthly');
  const check = jest.mocked(recordRevenueCatPurchase).mock.calls[0][2]!;
  expect(check).not.toThrow();
  if (changed === 'owner') mockOwner = 'owner-b';
  else mockBillingId = 'billing-b';
  expect(check).toThrow('Billing account changed.');
});

it('waits for the recording promise and preserves rejection', async () => {
  const error = new Error('synthetic recording failure');
  jest.mocked(recordRevenueCatPurchase).mockRejectedValue(error);
  await expect(recordPurchaseForBilling('monthly')).rejects.toBe(error);
});
