import {
  SUPERWALL_IDENTITY_WAIT_MS,
  useSuperwallIdentityStore,
  waitForSuperwallIdentity,
} from '@/store/useSuperwallIdentityStore';

let mockUsage: { billingUserId: string } | null = null;

jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: mockUsage }) },
}));

const billingUserId = '00000000-0000-4000-8000-000000000001';

describe('waitForSuperwallIdentity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUsage = null;
    useSuperwallIdentityStore.setState({ identifiedBillingUserId: null });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves false on abort and clears its timer', async () => {
    mockUsage = { billingUserId };
    const controller = new AbortController();
    const wait = waitForSuperwallIdentity(SUPERWALL_IDENTITY_WAIT_MS, controller.signal);

    controller.abort();

    await expect(wait).resolves.toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('checks readiness again when the timeout fires', async () => {
    useSuperwallIdentityStore.setState({ identifiedBillingUserId: billingUserId });
    const wait = waitForSuperwallIdentity();

    // The billing id arrives without a change to the identity store.
    mockUsage = { billingUserId };
    jest.advanceTimersByTime(SUPERWALL_IDENTITY_WAIT_MS);

    await expect(wait).resolves.toBe(true);
  });
});
