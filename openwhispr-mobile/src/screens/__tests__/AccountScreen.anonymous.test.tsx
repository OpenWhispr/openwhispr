import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { UsageInfo } from '@/data/remote/usageApi';

const mockUser: {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  isAnonymous: boolean;
} = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  emailVerified: true,
  isAnonymous: false,
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

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockRouterPush(...args),
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

const anonymousUser = {
  ...mockUser,
  id: 'anon-user',
  email: 'temp-1@anon.openwhispr.invalid',
  name: undefined,
  isAnonymous: true,
};

// After onboarding an anonymous session reaches Account with a user object.
// The real-account rows are wrong for it: Sign Out would revoke the session
// (and the purchase and notes it carries) and Delete Account is refused by
// the API. What it needs is a way to create the account.
describe('AccountScreen with an anonymous session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState.user = anonymousUser;
    mockAuthState.sessionCookie = 'session-cookie';
    mockAuthState.isGuest = false;
    mockUsageStoreState.usage = mockUnsubscribedUsage;
    mockLoadUsage.mockResolvedValue({
      status: 'loaded',
      usage: mockUnsubscribedUsage,
      loadedAt: 1,
    });
  });

  it('offers account creation instead of sign-out or deletion', () => {
    const { getByText, queryByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Create Account'));

    expect(mockRouterPush).toHaveBeenCalledWith('/auth');
    expect(queryByText('Sign Out')).toBeNull();
    expect(queryByText('Delete Account')).toBeNull();
    expect(mockAuthState.signOut).not.toHaveBeenCalled();
  });

  it('keeps sign-out and deletion for a real account', () => {
    mockAuthState.user = { ...mockUser, isAnonymous: false };

    const { getByText, queryByText } = render(<AccountScreen />);

    expect(getByText('Sign Out')).toBeTruthy();
    expect(getByText('Delete Account')).toBeTruthy();
    expect(queryByText('Create Account')).toBeNull();
  });
});
