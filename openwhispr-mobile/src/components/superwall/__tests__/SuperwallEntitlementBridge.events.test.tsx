import React from 'react';
import { Alert } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { SuperwallEntitlementBridge } from '../SuperwallEntitlementBridge';

const mockCaptureException = jest.fn();
let mockEventCallbacks: {
  onSuperwallEvent?: (info: {
    event: { event: string; error?: string };
    params: Record<string, unknown>;
  }) => void;
} = {};

jest.mock(
  'expo-superwall',
  () => ({
    useSuperwall: (selector: (state: object) => unknown) =>
      selector({ isConfigured: false, configurationError: null }),
    useSuperwallEvents: (callbacks: typeof mockEventCallbacks) => {
      mockEventCallbacks = callbacks;
    },
    useUser: () => ({
      identify: jest.fn(),
      update: jest.fn(),
      signOut: jest.fn(),
      setSubscriptionStatus: jest.fn(),
      user: null,
    }),
  }),
  { virtual: true },
);

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: object) => unknown) =>
    selector({ user: null, isGuest: false, isInitialized: true }),
}));

jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: object) => unknown) =>
      selector({ usage: null, load: jest.fn().mockResolvedValue({ status: 'skipped' }) }),
    { getState: () => ({ load: jest.fn().mockResolvedValue({ status: 'skipped' }) }) },
  ),
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: object) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));

jest.mock('@/lib/billingReconciliation', () => ({ reconcileStoreBilling: jest.fn() }));
jest.mock('@/lib/sentry', () => ({
  Sentry: {
    addBreadcrumb: jest.fn(),
    captureException: (...args: unknown[]) => mockCaptureException(...args),
  },
}));

describe('SuperwallEntitlementBridge transaction events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEventCallbacks = {};
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('records a failed transaction without presenting another alert', () => {
    render(<SuperwallEntitlementBridge />);

    act(() => {
      mockEventCallbacks.onSuperwallEvent?.({
        event: { event: 'transactionFail', error: 'Payment was declined' },
        params: {},
      });
    });

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment was declined' }),
      expect.objectContaining({
        tags: { feature: 'superwall', operation: 'transaction-failed' },
      }),
    );
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
