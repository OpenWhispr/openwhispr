import React, { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  DisabledSuperwallGateProvider,
  EnabledSuperwallGateProvider,
} from '@/components/superwall/SuperwallGateProvider';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import type {
  RegisterSuperwallGateOptions,
  SuperwallPurchaseCompletion,
} from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS, type SuperwallPlacement } from '@/lib/superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';

let mockPlacementCallbacks: Record<string, (...args: any[]) => void> = {};
let mockNativeFeature: (() => void) | undefined;
let mockResolveNativePlacement: (() => void) | undefined;
let mockShouldPresent = true;
let mockIsConfigured = true;
let mockConfigurationError: string | null = null;
const mockRegisterPlacement = jest.fn(
  ({ feature }: { feature?: () => void }) =>
    new Promise<void>((resolve) => {
      mockNativeFeature = feature;
      mockResolveNativePlacement = resolve;
      if (mockShouldPresent) {
        mockPlacementCallbacks.onPresent?.({ identifier: 'paywall-id', name: 'Paywall' });
      }
    }),
);
const mockReconcileStoreBilling = jest.fn();
const mockLogPaywallViewed = jest.fn();
const mockLogSubscription = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
}));

jest.mock(
  'expo-superwall',
  () => ({
    useSuperwall: (selector: (state: object) => unknown) =>
      selector({
        isConfigured: mockIsConfigured,
        configurationError: mockConfigurationError,
      }),
    usePlacement: (callbacks: Record<string, (...args: any[]) => void>) => {
      mockPlacementCallbacks = callbacks;
      return { registerPlacement: mockRegisterPlacement, state: { status: 'idle' } };
    },
  }),
  { virtual: true },
);

jest.mock('@/lib/billingReconciliation', () => ({
  reconcileStoreBilling: () => mockReconcileStoreBilling(),
}));

const mockIdentifyRevenueCatUser = jest.fn();
const mockRecordRevenueCatPurchase = jest.fn();

jest.mock('@/lib/revenuecat', () => ({
  identifyRevenueCatUser: (userId: string) => mockIdentifyRevenueCatUser(userId),
  recordRevenueCatPurchase: (productId: string) => mockRecordRevenueCatPurchase(productId),
}));

jest.mock('@/lib/sentry', () => ({
  Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));

jest.mock('@/lib/appsflyer', () => ({
  logPaywallViewed: (...args: unknown[]) => mockLogPaywallViewed(...args),
  logSubscription: (...args: unknown[]) => mockLogSubscription(...args),
}));

jest.mock('@/store/useAuthStore', () => {
  let state = {
    user: null as { id: string; email: string; emailVerified: boolean } | null,
    isGuest: false,
    isInitialized: true,
    sessionCookie: null as string | null,
  };
  const mockUseAuthStore = (selector: (value: typeof state) => unknown) => selector(state);
  mockUseAuthStore.getState = () => state;
  mockUseAuthStore.setState = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
  };
  return { useAuthStore: mockUseAuthStore };
});

jest.mock('@/store/useUsageStore', () => {
  let state = {
    usage: null as typeof usage | null,
    load: jest.fn(),
  };
  const mockUseUsageStore = (selector: (value: typeof state) => unknown) => selector(state);
  mockUseUsageStore.getState = () => state;
  mockUseUsageStore.setState = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
  };
  return { useUsageStore: mockUseUsageStore };
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function GateConsumer({
  placement,
  feature,
  onAccessGrantedWithoutPurchase,
  onPurchaseComplete,
  label = 'register',
}: {
  placement: SuperwallPlacement;
  feature?: () => void;
  onAccessGrantedWithoutPurchase?: () => void;
  onPurchaseComplete?: (completion: SuperwallPurchaseCompletion) => void;
  label?: string;
}): React.JSX.Element {
  const { register } = useSuperwallGate();
  const [result, setResult] = useState('pending');
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          const options: RegisterSuperwallGateOptions = {
            placement,
            feature,
            onAccessGrantedWithoutPurchase,
            onPurchaseComplete,
          };
          register(options).then((granted) => setResult(String(granted)));
        }}
      >
        <Text>{label}</Text>
      </Pressable>
      <Text testID="result">{result}</Text>
    </>
  );
}

const usage = {
  billingUserId: '00000000-0000-4000-8000-000000000001',
  wordsUsed: 0,
  wordsRemaining: 100,
  limit: 100,
  plan: 'free',
  status: 'active',
  isSubscribed: false,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  billingInterval: null,
  resetAt: 'rolling',
} as const;

describe('SuperwallGateProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlacementCallbacks = {};
    mockNativeFeature = undefined;
    mockResolveNativePlacement = undefined;
    mockShouldPresent = true;
    mockIsConfigured = true;
    mockConfigurationError = null;
    mockReconcileStoreBilling.mockResolvedValue(usage);
    mockIdentifyRevenueCatUser.mockResolvedValue(true);
    mockRecordRevenueCatPurchase.mockResolvedValue(true);
    useAuthStore.setState({
      user: {
        id: 'internal-user-id',
        email: 'user@example.com',
        emailVerified: true,
        isAnonymous: false,
      },
      isGuest: false,
      isInitialized: true,
      sessionCookie: 'session=test',
    });
    useUsageStore.setState({
      usage,
      load: jest.fn().mockResolvedValue({ status: 'loaded', usage, loadedAt: Date.now() }),
    });
  });

  it('logs a paywall view only when Superwall presents one', () => {
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));

    expect(mockLogPaywallViewed).toHaveBeenCalledWith(SUPERWALL_PLACEMENTS.accountBillingOpen);
    expect(mockLogPaywallViewed).toHaveBeenCalledTimes(1);
  });

  it.each(['skip', 'error'] as const)(
    'does not log a paywall view for a registration %s before presentation',
    async (outcome) => {
      mockShouldPresent = false;
      const screen = render(
        <EnabledSuperwallGateProvider>
          <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
        </EnabledSuperwallGateProvider>,
      );

      fireEvent.press(screen.getByText('register'));
      act(() => {
        if (outcome === 'skip') {
          mockPlacementCallbacks.onSkip?.({ type: 'PlacementNotFound' });
        } else {
          mockPlacementCallbacks.onError?.('presentation failed');
        }
      });

      await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('false'));
      expect(mockLogPaywallViewed).not.toHaveBeenCalled();
      expect(mockLogSubscription).not.toHaveBeenCalled();
    },
  );

  it('settles a transactional dismissal even when the native promise never resolves', async () => {
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.cloudUsageLimitReached} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'declined' }));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('false'));
  });

  it('settles purchase access and runs a feature at most once', async () => {
    const feature = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.cloudUsageLimitReached} feature={feature} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);

    act(() => {
      mockNativeFeature?.();
      mockResolveNativePlacement?.();
    });
    expect(feature).toHaveBeenCalledTimes(1);
  });

  it('holds the gate and reconciliation until the purchase is recorded', async () => {
    const feature = jest.fn();
    const record = deferred<boolean>();
    mockRecordRevenueCatPurchase.mockReturnValue(record.promise);
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.cloudUsageLimitReached} feature={feature} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );
    await act(async () => {});

    expect(mockRecordRevenueCatPurchase).toHaveBeenCalledWith('pro.monthly');
    expect(screen.getByTestId('result').props.children).toBe('pending');
    expect(feature).not.toHaveBeenCalled();
    expect(mockReconcileStoreBilling).not.toHaveBeenCalled();

    await act(async () => record.resolve(true));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
    expect(mockReconcileStoreBilling).toHaveBeenCalledTimes(1);
  });

  it('keeps holding the gate when the native placement completes mid-recording', async () => {
    const feature = jest.fn();
    const record = deferred<boolean>();
    mockRecordRevenueCatPurchase.mockReturnValue(record.promise);
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.cloudUsageLimitReached} feature={feature} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );
    act(() => {
      mockNativeFeature?.();
      mockResolveNativePlacement?.();
    });
    await act(async () => {});

    expect(screen.getByTestId('result').props.children).toBe('pending');
    expect(feature).not.toHaveBeenCalled();

    await act(async () => record.resolve(true));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
  });

  it('processes a purchased dismissal once when it repeats during recording', async () => {
    const record = deferred<boolean>();
    mockRecordRevenueCatPurchase.mockReturnValue(record.promise);
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => {
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' });
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' });
    });
    await act(async () => {});

    expect(mockLogSubscription).toHaveBeenCalledTimes(1);
    expect(mockIdentifyRevenueCatUser).toHaveBeenCalledTimes(1);
    expect(mockRecordRevenueCatPurchase).toHaveBeenCalledTimes(1);
    expect(mockReconcileStoreBilling).not.toHaveBeenCalled();
    expect(screen.getByTestId('result').props.children).toBe('pending');

    await act(async () => record.resolve(true));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(mockReconcileStoreBilling).toHaveBeenCalledTimes(1);
  });

  it('identifies RevenueCat with the billing user before recording the purchase', async () => {
    const identify = deferred<boolean>();
    mockIdentifyRevenueCatUser.mockReturnValue(identify.promise);
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );
    await act(async () => {});

    expect(mockIdentifyRevenueCatUser).toHaveBeenCalledWith(usage.billingUserId);
    expect(mockRecordRevenueCatPurchase).not.toHaveBeenCalled();

    await act(async () => identify.resolve(true));

    await waitFor(() => expect(mockRecordRevenueCatPurchase).toHaveBeenCalledWith('pro.monthly'));
    await waitFor(() => expect(mockReconcileStoreBilling).toHaveBeenCalled());
  });

  it('records the purchase without identifying when billing usage is unavailable', async () => {
    useUsageStore.setState({ usage: null });
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(mockRecordRevenueCatPurchase).toHaveBeenCalledWith('pro.monthly'));
    expect(mockIdentifyRevenueCatUser).not.toHaveBeenCalled();
  });

  it('releases the gate when recording does not settle in time', async () => {
    jest.useFakeTimers();
    try {
      mockRecordRevenueCatPurchase.mockReturnValue(new Promise<boolean>(() => {}));
      const screen = render(
        <EnabledSuperwallGateProvider>
          <GateConsumer placement={SUPERWALL_PLACEMENTS.cloudUsageLimitReached} />
        </EnabledSuperwallGateProvider>,
      );

      fireEvent.press(screen.getByText('register'));
      act(() =>
        mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
      );
      await act(async () => {});
      expect(screen.getByTestId('result').props.children).toBe('pending');

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });

      await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
      expect(mockReconcileStoreBilling).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not record a product with RevenueCat on restoration', async () => {
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'restored' }));

    await waitFor(() => expect(mockReconcileStoreBilling).toHaveBeenCalled());
    expect(mockRecordRevenueCatPurchase).not.toHaveBeenCalled();
  });

  it('reports a confirmed purchase exactly once', async () => {
    const onPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={onPurchaseComplete}
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(onPurchaseComplete).toHaveBeenCalledWith('purchased'));
    act(() => {
      mockNativeFeature?.();
      mockResolveNativePlacement?.();
    });
    expect(onPurchaseComplete).toHaveBeenCalledTimes(1);
    expect(mockLogSubscription).toHaveBeenCalledWith(
      'pro.monthly',
      SUPERWALL_PLACEMENTS.accountBillingOpen,
    );
    expect(mockLogSubscription).toHaveBeenCalledTimes(1);
  });

  it('reports a confirmed restoration', async () => {
    const onPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={onPurchaseComplete}
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'restored' }));

    await waitFor(() => expect(onPurchaseComplete).toHaveBeenCalledWith('restored'));
    expect(mockLogSubscription).not.toHaveBeenCalled();
  });

  it('reports a purchase after the native feature completes before dismissal', async () => {
    const onPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={onPurchaseComplete}
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => mockNativeFeature?.());
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(onPurchaseComplete).toHaveBeenCalledWith('purchased'));
  });

  it('serializes a presented gate through dismissal after native completion', async () => {
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const thirdOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={thirdOnPurchaseComplete}
          label="third register"
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('first register'));
    act(() => mockResolveNativePlacement?.());
    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('true'));

    fireEvent.press(screen.getByText('second register'));
    await waitFor(() => expect(screen.getAllByTestId('result')[1].props.children).toBe('false'));

    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'restored' }));

    await waitFor(() => expect(firstOnPurchaseComplete).toHaveBeenCalledWith('restored'));
    expect(secondOnPurchaseComplete).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('third register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(thirdOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(firstOnPurchaseComplete).toHaveBeenCalledTimes(1);
    expect(secondOnPurchaseComplete).not.toHaveBeenCalled();
    expect(thirdOnPurchaseComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate terminal event before a later registration', async () => {
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('first register'));
    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'declined' }));
    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('false'));

    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'restored' }));
    expect(firstOnPurchaseComplete).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('second register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(secondOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(secondOnPurchaseComplete).toHaveBeenCalledTimes(1);
  });

  it('does not retain ownership after a no-paywall native completion', async () => {
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('first register'));
    act(() => mockNativeFeature?.());
    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('true'));

    mockShouldPresent = true;
    fireEvent.press(screen.getByText('second register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(secondOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(firstOnPurchaseComplete).not.toHaveBeenCalled();
  });

  it('reports no-paywall access without purchase at most once', async () => {
    const feature = jest.fn();
    const onAccessGrantedWithoutPurchase = jest.fn();
    const onPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          feature={feature}
          onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
          onPurchaseComplete={onPurchaseComplete}
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('register'));
    act(() => {
      mockNativeFeature?.();
      mockResolveNativePlacement?.();
    });

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
    expect(onAccessGrantedWithoutPurchase).toHaveBeenCalledTimes(1);
    expect(onPurchaseComplete).not.toHaveBeenCalled();
  });

  it.each(['purchased', 'restored'] as const)(
    'never reports no-purchase access for a confirmed %s',
    async (completion) => {
      const onAccessGrantedWithoutPurchase = jest.fn();
      const onPurchaseComplete = jest.fn();
      const screen = render(
        <EnabledSuperwallGateProvider>
          <GateConsumer
            placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
            onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
            onPurchaseComplete={onPurchaseComplete}
          />
        </EnabledSuperwallGateProvider>,
      );

      fireEvent.press(screen.getByText('register'));
      act(() => mockNativeFeature?.());
      expect(onAccessGrantedWithoutPurchase).not.toHaveBeenCalled();

      act(() =>
        mockPlacementCallbacks.onDismiss?.(
          {},
          completion === 'purchased'
            ? { type: 'purchased', productId: 'pro.monthly' }
            : { type: 'restored' },
        ),
      );

      await waitFor(() => expect(onPurchaseComplete).toHaveBeenCalledWith(completion));
      expect(onAccessGrantedWithoutPurchase).not.toHaveBeenCalled();
    },
  );

  it.each(['purchased', 'restored'] as const)(
    'ignores late native completion after a terminal %s',
    async (completion) => {
      const onAccessGrantedWithoutPurchase = jest.fn();
      const onPurchaseComplete = jest.fn();
      const screen = render(
        <EnabledSuperwallGateProvider>
          <GateConsumer
            placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
            onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
            onPurchaseComplete={onPurchaseComplete}
          />
        </EnabledSuperwallGateProvider>,
      );

      fireEvent.press(screen.getByText('register'));
      act(() =>
        mockPlacementCallbacks.onDismiss?.(
          {},
          completion === 'purchased'
            ? { type: 'purchased', productId: 'pro.monthly' }
            : { type: 'restored' },
        ),
      );
      await waitFor(() => expect(onPurchaseComplete).toHaveBeenCalledWith(completion));

      await act(async () => {
        mockNativeFeature?.();
        mockResolveNativePlacement?.();
        await Promise.resolve();
      });

      expect(onAccessGrantedWithoutPurchase).not.toHaveBeenCalled();
      expect(onPurchaseComplete).toHaveBeenCalledTimes(1);
    },
  );

  it('does not report a purchase when the paywall is declined', async () => {
    const onPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={onPurchaseComplete}
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));
    act(() => mockPlacementCallbacks.onDismiss?.({}, { type: 'declined' }));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('false'));
    expect(onPurchaseComplete).not.toHaveBeenCalled();
    expect(mockLogSubscription).not.toHaveBeenCalled();
  });

  it('settles a pre-presentation PlacementNotFound and ignores its stale skip after a later registration', async () => {
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('first register'));
    act(() => mockPlacementCallbacks.onSkip?.({ type: 'PlacementNotFound' }));

    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('false'));
    expect(firstOnPurchaseComplete).not.toHaveBeenCalled();

    mockShouldPresent = true;
    fireEvent.press(screen.getByText('second register'));
    act(() => mockPlacementCallbacks.onSkip?.({ type: 'PlacementNotFound' }));
    expect(screen.getAllByTestId('result')[1].props.children).toBe('pending');

    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(secondOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(secondOnPurchaseComplete).toHaveBeenCalledTimes(1);
  });

  it('fails open after a pre-presentation error and allows a later registration', async () => {
    const feature = jest.fn();
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.aiActionRun}
          feature={feature}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('first register'));
    act(() => mockPlacementCallbacks.onError?.('presentation failed'));

    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
    expect(firstOnPurchaseComplete).not.toHaveBeenCalled();

    mockShouldPresent = true;
    fireEvent.press(screen.getByText('second register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(secondOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(secondOnPurchaseComplete).toHaveBeenCalledTimes(1);
  });

  it('settles a post-presentation error and allows a later registration', async () => {
    const firstOnPurchaseComplete = jest.fn();
    const secondOnPurchaseComplete = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={firstOnPurchaseComplete}
          label="first register"
        />
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onPurchaseComplete={secondOnPurchaseComplete}
          label="second register"
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('first register'));
    act(() => mockPlacementCallbacks.onError?.('presentation failed'));

    await waitFor(() => expect(screen.getAllByTestId('result')[0].props.children).toBe('false'));
    expect(firstOnPurchaseComplete).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('second register'));
    act(() =>
      mockPlacementCallbacks.onDismiss?.({}, { type: 'purchased', productId: 'pro.monthly' }),
    );

    await waitFor(() => expect(secondOnPurchaseComplete).toHaveBeenCalledWith('purchased'));
    expect(secondOnPurchaseComplete).toHaveBeenCalledTimes(1);
  });

  it('fails open for a non-transactional SDK error', async () => {
    const feature = jest.fn();
    const onAccessGrantedWithoutPurchase = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.aiActionRun}
          feature={feature}
          onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('register'));
    act(() => mockPlacementCallbacks.onError?.('presentation failed'));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
    expect(onAccessGrantedWithoutPurchase).toHaveBeenCalledTimes(1);
  });

  // An anonymous onboarding session has no way to attach an in-app purchase to
  // a person; transactional placements send it to sign-up like a guest.
  it('routes an anonymous session to sign-up for a transactional placement', async () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    useAuthStore.setState({
      user: {
        id: 'anon-user',
        email: 'temp-1@anon.openwhispr.invalid',
        emailVerified: false,
        isAnonymous: true,
      },
    });
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer placement={SUPERWALL_PLACEMENTS.accountBillingOpen} />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('false'));
    expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/auth/));
    expect(mockRegisterPlacement).not.toHaveBeenCalled();
  });

  it('opens existing subscriber billing when Superwall is unavailable', async () => {
    const feature = jest.fn();
    const onAccessGrantedWithoutPurchase = jest.fn();
    useUsageStore.setState({ usage: { ...usage, isSubscribed: true, plan: 'pro' } });
    const screen = render(
      <DisabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          feature={feature}
          onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
        />
      </DisabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(feature).toHaveBeenCalledTimes(1);
    expect(onAccessGrantedWithoutPurchase).toHaveBeenCalledTimes(1);
  });

  it('reports no-purchase access for an eligible skip', async () => {
    const onAccessGrantedWithoutPurchase = jest.fn();
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
        />
      </EnabledSuperwallGateProvider>,
    );

    mockShouldPresent = false;
    fireEvent.press(screen.getByText('register'));
    act(() =>
      mockPlacementCallbacks.onSkip?.({ type: 'Holdout', experiment: { id: 'holdout-1' } }),
    );

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(onAccessGrantedWithoutPurchase).toHaveBeenCalledTimes(1);
  });

  it('reports existing-subscriber access when configuration is unavailable', async () => {
    const onAccessGrantedWithoutPurchase = jest.fn();
    mockIsConfigured = false;
    mockConfigurationError = 'invalid key';
    useUsageStore.setState({ usage: { ...usage, isSubscribed: true, plan: 'pro' } });
    const screen = render(
      <EnabledSuperwallGateProvider>
        <GateConsumer
          placement={SUPERWALL_PLACEMENTS.accountBillingOpen}
          onAccessGrantedWithoutPurchase={onAccessGrantedWithoutPurchase}
        />
      </EnabledSuperwallGateProvider>,
    );

    fireEvent.press(screen.getByText('register'));

    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('true'));
    expect(onAccessGrantedWithoutPurchase).toHaveBeenCalledTimes(1);
  });
});
