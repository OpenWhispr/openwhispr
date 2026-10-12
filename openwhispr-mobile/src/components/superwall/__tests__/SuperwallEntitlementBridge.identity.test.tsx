import React from 'react';
import { act, render } from '@testing-library/react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import { SuperwallEntitlementBridge } from '../SuperwallEntitlementBridge';

const mockIdentify = jest.fn().mockResolvedValue(undefined);
const mockSignOut = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn();
const mockSetSubscriptionStatus = jest.fn();

let mockSuperwallUser: { appUserId?: string } | null = null;
let mockAuthState = {
  user: null as { id: string } | null,
  isGuest: false,
  isInitialized: true,
};
let mockUsage: UsageInfo | null = null;

const mockLoad = jest.fn().mockResolvedValue({ status: 'skipped', reason: 'fresh', usage: null });

jest.mock(
  'expo-superwall',
  () => ({
    useSuperwall: (selector: (state: object) => unknown) =>
      selector({ isConfigured: true, configurationError: null }),
    useSuperwallEvents: () => {},
    useUser: () => ({
      identify: mockIdentify,
      // Fresh function identities per render, like the real hook — the bridge
      // must stay stable even though these appear in effect dependency arrays.
      update: (attributes: unknown) => mockUpdate(attributes),
      signOut: mockSignOut,
      setSubscriptionStatus: (status: unknown) => mockSetSubscriptionStatus(status),
      user: mockSuperwallUser,
    }),
  }),
  { virtual: true },
);

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: object) => unknown) => selector(mockAuthState),
}));

jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: object) => unknown) => selector({ usage: mockUsage, load: mockLoad }),
    { getState: () => ({ load: mockLoad }) },
  ),
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: object) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));

jest.mock('@/lib/billingReconciliation', () => ({
  reconcileStoreBilling: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));

const billingUserId = '00000000-0000-4000-8000-000000000001';

const usageWithBillingId: UsageInfo = {
  billingUserId,
  wordsUsed: 100,
  wordsRemaining: 900,
  limit: 1000,
  plan: 'free',
  status: 'active',
  isSubscribed: false,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  billingInterval: null,
  resetAt: '2026-08-17T00:00:00.000Z',
};

async function renderBridge(): Promise<void> {
  render(<SuperwallEntitlementBridge />);
  // Flush the async identity-sync effect.
  await act(async () => {});
}

describe('SuperwallEntitlementBridge identity sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockReset().mockResolvedValue(undefined);
    mockSetSubscriptionStatus.mockReset().mockResolvedValue(undefined);
    mockSuperwallUser = null;
    mockAuthState = { user: null, isGuest: false, isInitialized: true };
    mockUsage = null;
  });

  it('keeps the persisted identity while a signed-in user waits for the billing id', async () => {
    // Cold start: auth restored, Superwall configured with last session's
    // identity, but the in-memory usage store has not loaded yet. Resetting
    // here would churn the identity on every launch.
    mockAuthState = { user: { id: 'user-1' }, isGuest: false, isInitialized: true };
    mockSuperwallUser = { appUserId: billingUserId };
    mockUsage = null;

    await renderBridge();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('identifies the billing user once the billing id is available', async () => {
    mockAuthState = { user: { id: 'user-1' }, isGuest: false, isInitialized: true };
    mockSuperwallUser = null;
    mockUsage = usageWithBillingId;

    await renderBridge();

    expect(mockIdentify).toHaveBeenCalledWith(billingUserId, { restorePaywallAssignments: true });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('signs out the persisted identity when the app user is signed out', async () => {
    mockAuthState = { user: null, isGuest: false, isInitialized: true };
    mockSuperwallUser = { appUserId: billingUserId };

    await renderBridge();

    expect(mockSignOut).toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it('pushes status and attributes exactly once when the push itself re-renders the tree', async () => {
    mockAuthState = { user: { id: 'user-1' }, isGuest: false, isInitialized: true };
    mockSuperwallUser = { appUserId: billingUserId };
    mockUsage = usageWithBillingId;

    // A real push refreshes the SDK's user object, re-rendering the tree and
    // superseding the in-flight effect run. Simulate that by re-rendering from
    // inside the push before it resolves — the completed push must still be
    // recorded so the re-run doesn't push again (the former infinite loop).
    let triggerRerender: (() => void) | null = null;
    mockSetSubscriptionStatus.mockImplementation(() => {
      triggerRerender?.();
      return Promise.resolve();
    });

    const view = render(<SuperwallEntitlementBridge />);
    triggerRerender = () => view.rerender(<SuperwallEntitlementBridge />);
    await act(async () => {});
    triggerRerender = null;

    expect(mockSetSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
