import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';
import { ApiError } from '@/lib/apiClient';

const mockUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  emailVerified: true,
};
const mockAuthState: {
  user: typeof mockUser | null;
  sessionCookie: string | null;
  isGuest: boolean;
  signOut: jest.Mock;
  deleteAccount: jest.Mock;
} = {
  user: mockUser,
  sessionCookie: 'session-cookie',
  isGuest: false,
  signOut: jest.fn(),
  deleteAccount: jest.fn(),
};
const mockRegisterSuperwallGate = jest.fn();
const mockRouterReplace = jest.fn();
const mockCreateStripeBillingPortalSession = jest.fn();
const mockOpenExternal = jest.fn();
const mockOpenMail = jest.fn();
const mockGetAppStorefrontCountryCode = jest.fn();
const mockShowAppStoreManageSubscriptions = jest.fn();
const mockLoadUsage = jest.fn();
const mockBeginBillingSession = jest.fn();
const mockEndBillingSession = jest.fn();
const mockSubscribedUsage: UsageInfo = {
  billingUserId: '00000000-0000-4000-8000-000000000001',
  wordsUsed: 100,
  wordsRemaining: 1_900,
  limit: 2_000,
  plan: 'pro',
  status: 'active',
  isSubscribed: true,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
  billingInterval: 'monthly',
  resetAt: '2026-08-18T00:00:00.000Z',
  entitlementSources: {
    personal: true,
    provider: false,
    workspaceIds: [],
  },
};
const mockUnsubscribedUsage: UsageInfo = {
  ...mockSubscribedUsage,
  plan: 'free',
  isSubscribed: false,
  currentPeriodEnd: null,
  billingInterval: null,
  entitlementSources: {
    personal: false,
    provider: false,
    workspaceIds: [],
  },
};
const mockUsageStoreState: {
  usage: UsageInfo | null;
  isBillingSessionActive: boolean;
  load: jest.Mock;
  beginBillingSession: jest.Mock;
  endBillingSession: jest.Mock;
} = {
  usage: mockSubscribedUsage,
  isBillingSessionActive: false,
  load: mockLoadUsage,
  beginBillingSession: mockBeginBillingSession,
  endBillingSession: mockEndBillingSession,
};

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: (...args: unknown[]) => mockRouterReplace(...args),
  },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(() => mockAuthState, {
    getState: () => mockAuthState,
  }),
}));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (state: { reset: jest.Mock }) => unknown) =>
    selector({ reset: jest.fn() }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: typeof mockUsageStoreState) => unknown) => selector(mockUsageStoreState),
    { getState: () => mockUsageStoreState },
  ),
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegisterSuperwallGate }),
}));
jest.mock('@/data/remote/billingApi', () => ({
  createStripeBillingPortalSession: (...args: unknown[]) =>
    mockCreateStripeBillingPortalSession(...args),
}));
jest.mock('@/lib/apiClient', () => ({
  ApiError: class BillingApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
jest.mock('@/lib/openExternal', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  openMail: (...args: unknown[]) => mockOpenMail(...args),
}));
jest.mock('@/lib/revenuecat', () => ({
  getAppStorefrontCountryCode: (...args: unknown[]) => mockGetAppStorefrontCountryCode(...args),
  showAppStoreManageSubscriptions: (...args: unknown[]) =>
    mockShowAppStoreManageSubscriptions(...args),
}));
jest.mock('@/lib/alerts', () => ({
  confirmAccountDeletion: jest.fn(),
  confirmDestructive: jest.fn(),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/config/colors', () => ({ iosColor: jest.fn(() => '#999') }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SettingsSection', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
      <Pressable onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>
    ),
    SettingsSection: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('@/components/ui/SettingsScreen', () => ({
  SettingsScreen: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));
jest.mock('@/components/ui/PlanBadge', () => ({ PlanBadge: () => null }));
jest.mock('@/components/ui/UsageMeter', () => ({ UsageMeter: () => null }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassBackButton', () => ({ GlassBackButton: () => null }));
jest.mock('@/components/ui/TabScreenHeader', () => ({ TabScreenHeader: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));

import AccountScreen from '../AccountScreen';

type RegisteredGateOptions = {
  feature?: () => void;
  onAccessGrantedWithoutPurchase?: () => void;
  onPurchaseComplete?: (value: 'purchased' | 'restored') => void;
};

function getRegisteredGateOptions(): RegisteredGateOptions {
  return mockRegisterSuperwallGate.mock.calls[0][0] as RegisteredGateOptions;
}

describe('AccountScreen billing management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState.user = mockUser;
    mockAuthState.sessionCookie = 'session-cookie';
    mockAuthState.isGuest = false;
    mockRegisterSuperwallGate.mockResolvedValue(true);
    mockCreateStripeBillingPortalSession.mockResolvedValue('https://billing.stripe.com/p/session');
    mockOpenExternal.mockResolvedValue(true);
    mockOpenMail.mockResolvedValue(true);
    mockGetAppStorefrontCountryCode.mockResolvedValue('USA');
    mockShowAppStoreManageSubscriptions.mockResolvedValue(true);
    mockLoadUsage.mockResolvedValue({
      status: 'loaded',
      usage: mockSubscribedUsage,
      loadedAt: Date.now(),
    });
    mockUsageStoreState.usage = mockSubscribedUsage;
    mockUsageStoreState.isBillingSessionActive = false;
    mockBeginBillingSession.mockImplementation(() => {
      mockUsageStoreState.isBillingSessionActive = true;
    });
    mockEndBillingSession.mockImplementation(() => {
      mockUsageStoreState.isBillingSessionActive = false;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens Stripe management only for an authoritative US web subscriber', async () => {
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Plans & Billing'));

    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    const gateOptions = getRegisteredGateOptions();
    expect(gateOptions.feature).toBeUndefined();
    expect(gateOptions.onAccessGrantedWithoutPurchase).toEqual(expect.any(Function));
    gateOptions.onAccessGrantedWithoutPurchase?.();

    await waitFor(() => expect(mockGetAppStorefrontCountryCode).toHaveBeenCalled());
    await waitFor(() => expect(mockCreateStripeBillingPortalSession).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'https://billing.stripe.com/p/session',
        expect.any(String),
      ),
    );
    expect(mockUsageStoreState.isBillingSessionActive).toBe(true);
    expect(mockBeginBillingSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpenExternal.mock.invocationCallOrder[0],
    );
  });

  it('clears billing resume when the Stripe portal cannot open', async () => {
    mockOpenExternal.mockResolvedValue(false);
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalled());
    expect(mockUsageStoreState.isBillingSessionActive).toBe(false);
  });

  it('offers support without requesting a portal for a non-US web subscriber', async () => {
    mockGetAppStorefrontCountryCode.mockResolvedValue('DEU');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Manage Subscription',
        "You can't make changes to your plan in the app. We know it's not ideal. Contact OpenWhispr Support for help with cancellation or billing.",
        expect.arrayContaining([
          expect.objectContaining({ text: 'Contact Support', onPress: expect.any(Function) }),
          expect.objectContaining({ text: 'Done', style: 'cancel' }),
        ]),
      ),
    );
    expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('treats an active workspace entitlement as authoritative web access', async () => {
    mockUsageStoreState.usage = {
      ...mockSubscribedUsage,
      entitlementSources: {
        personal: false,
        provider: false,
        workspaceIds: ['workspace-1'],
      },
    };
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() => expect(mockCreateStripeBillingPortalSession).toHaveBeenCalled());
    expect(mockShowAppStoreManageSubscriptions).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['contradictory', { personal: false, provider: false, workspaceIds: [] as string[] }],
  ] as const)(
    'fails closed to Contact Support when entitlement sources are %s',
    async (_label, entitlementSources) => {
      mockUsageStoreState.usage = {
        ...mockSubscribedUsage,
        entitlementSources,
      };
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const { getByText } = render(<AccountScreen />);
      fireEvent.press(getByText('Plans & Billing'));
      await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
      getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith(
          'Manage Subscription',
          "You can't make changes to your plan in the app. We know it's not ideal. Contact OpenWhispr Support for help with cancellation or billing.",
          expect.arrayContaining([
            expect.objectContaining({ text: 'Contact Support', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'Done', style: 'cancel' }),
          ]),
        ),
      );
      const buttons = alertSpy.mock.calls.find(([title]) => title === 'Manage Subscription')?.[2];
      const contactSupport = buttons?.find((button) => button.text === 'Contact Support');
      contactSupport?.onPress?.();

      expect(mockOpenMail).toHaveBeenCalledWith(
        'support@openwhispr.com',
        'OpenWhispr Billing Support',
      );
      expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
      expect(mockShowAppStoreManageSubscriptions).not.toHaveBeenCalled();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    },
  );

  it('uses Apple management for an authoritative App Store subscriber', async () => {
    mockUsageStoreState.usage = {
      ...mockSubscribedUsage,
      entitlementSources: {
        personal: true,
        provider: true,
        workspaceIds: ['former-workspace'],
      },
    };
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() => expect(mockShowAppStoreManageSubscriptions).toHaveBeenCalled());
    expect(mockGetAppStorefrontCountryCode).not.toHaveBeenCalled();
    expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('falls back to Apples subscriptions URL when native Apple management fails', async () => {
    mockUsageStoreState.usage = {
      ...mockSubscribedUsage,
      entitlementSources: {
        personal: false,
        provider: true,
        workspaceIds: [],
      },
    };
    mockShowAppStoreManageSubscriptions.mockResolvedValue(false);
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() =>
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'itms-apps://apps.apple.com/account/subscriptions',
        expect.any(String),
      ),
    );
    expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
  });

  it('shows retry feedback when the portal fails for an authoritative web subscriber', async () => {
    mockCreateStripeBillingPortalSession.mockRejectedValue(new ApiError('portal unavailable', 500));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Couldn't Open Billing",
        'Please try again in a moment.',
      ),
    );
    expect(mockShowAppStoreManageSubscriptions).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('offers support when the authoritative web portal refuses the request', async () => {
    mockCreateStripeBillingPortalSession.mockRejectedValue(new ApiError('not owner', 403));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    getRegisteredGateOptions().onAccessGrantedWithoutPurchase?.();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Manage Subscription',
        expect.stringContaining("We know it's not ideal"),
        expect.any(Array),
      ),
    );
    expect(mockShowAppStoreManageSubscriptions).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('loads unknown authenticated usage before registering existing-subscriber management', async () => {
    mockUsageStoreState.usage = null;
    mockLoadUsage.mockResolvedValue({
      status: 'loaded',
      usage: mockSubscribedUsage,
      loadedAt: Date.now(),
    });
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));

    await waitFor(() => expect(mockLoadUsage).toHaveBeenCalledWith(true));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    expect(getRegisteredGateOptions().onAccessGrantedWithoutPurchase).toEqual(expect.any(Function));
  });

  it('does not register a null authenticated usage snapshot as free when loading fails', async () => {
    mockUsageStoreState.usage = null;
    mockLoadUsage.mockResolvedValue({
      status: 'failed',
      error: new Error('usage unavailable'),
      usage: null,
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "Couldn't Load Billing",
        'Please try again in a moment.',
      ),
    );
    expect(mockRegisterSuperwallGate).not.toHaveBeenCalled();
  });

  it('keeps guest billing routed through the existing Superwall authentication gate', async () => {
    mockAuthState.user = null;
    mockAuthState.sessionCookie = null;
    mockAuthState.isGuest = true;
    mockUsageStoreState.usage = null;
    const { getByText } = render(<AccountScreen />);
    fireEvent.press(getByText('Plans & Billing'));

    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    expect(mockLoadUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['purchased', 'purchased'],
    ['restored', 'restored'],
  ] as const)('routes a free users confirmed %s completion to Home', async (_label, completion) => {
    mockUsageStoreState.usage = mockUnsubscribedUsage;
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());

    const gateOptions = getRegisteredGateOptions();
    expect(gateOptions.onAccessGrantedWithoutPurchase).toEqual(expect.any(Function));
    gateOptions.onPurchaseComplete?.(completion);

    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: '/(tabs)/(record)',
      params: { proCompletion: completion },
    });
  });

  it('opens App Store management when Superwall grants access before backend usage catches up', async () => {
    mockUsageStoreState.usage = mockUnsubscribedUsage;
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());

    const gateOptions = getRegisteredGateOptions();
    expect(gateOptions.onAccessGrantedWithoutPurchase).toEqual(expect.any(Function));
    gateOptions.onAccessGrantedWithoutPurchase?.();

    await waitFor(() => expect(mockShowAppStoreManageSubscriptions).toHaveBeenCalled());
    expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
  });

  it.each(['purchased', 'restored'] as const)(
    'routes an unexpected subscribed-gate %s Home without opening management',
    async (completion) => {
      const { getByText } = render(<AccountScreen />);

      fireEvent.press(getByText('Plans & Billing'));
      await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
      const gateOptions = getRegisteredGateOptions();
      gateOptions.onPurchaseComplete?.(completion);

      expect(mockRouterReplace).toHaveBeenCalledWith({
        pathname: '/(tabs)/(record)',
        params: { proCompletion: completion },
      });
      expect(mockCreateStripeBillingPortalSession).not.toHaveBeenCalled();
      expect(mockShowAppStoreManageSubscriptions).not.toHaveBeenCalled();
    },
  );

  it('opens management when an already-subscribed gate grants access without a paywall', async () => {
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Plans & Billing'));
    await waitFor(() => expect(mockRegisterSuperwallGate).toHaveBeenCalled());
    const gateOptions = getRegisteredGateOptions();
    gateOptions.onAccessGrantedWithoutPurchase?.();

    expect(gateOptions.feature).toBeUndefined();
    await waitFor(() => expect(mockGetAppStorefrontCountryCode).toHaveBeenCalled());
  });
});
