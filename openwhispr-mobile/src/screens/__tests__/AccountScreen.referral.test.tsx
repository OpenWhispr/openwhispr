import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { UsageInfo } from '@/data/remote/usageApi';

type MockUser = { id: string; email: string; name: string; emailVerified: boolean };
const mockUser: MockUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  emailVerified: true,
};
const mockAuthState: {
  user: MockUser | null;
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
const mockRouterPush = jest.fn();
const mockUsage: UsageInfo = {
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
  entitlementSources: { personal: true, provider: false, workspaceIds: [] },
};
const mockUsageStoreState = {
  usage: mockUsage as UsageInfo | null,
  isBillingSessionActive: false,
  load: jest.fn().mockResolvedValue({ status: 'loaded', usage: mockUsage, loadedAt: 0 }),
  beginBillingSession: jest.fn(),
  endBillingSession: jest.fn(),
};

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
  router: { push: (...args: unknown[]) => mockRouterPush(...args), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(() => mockAuthState, { getState: () => mockAuthState }),
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
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/lib/affiliateOffer', () => ({
  loadAffiliateOffer: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/store/useAffiliateStore', () => ({
  useAffiliateStore: { getState: () => ({ link: '', prepare: jest.fn() }) },
}));
jest.mock('@/components/AccountCreatorLink', () => ({ AccountCreatorLink: () => null }));
jest.mock('@/data/remote/billingApi', () => ({ createStripeBillingPortalSession: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({
  ApiError: class BillingApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
jest.mock('@/lib/openExternal', () => ({ openExternal: jest.fn(), openMail: jest.fn() }));
jest.mock('@/lib/revenuecat', () => ({
  getAppStorefrontCountryCode: jest.fn(),
  showAppStoreManageSubscriptions: jest.fn(),
}));
jest.mock('@/lib/alerts', () => ({
  confirmAccountDeletion: jest.fn(),
  confirmDestructive: jest.fn(),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/config/colors', () => ({ iosColor: jest.fn(() => '#999') }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
// Unlike the billing suite's mock, this one renders section titles so the
// test can assert their order.
jest.mock('@/components/ui/SettingsSection', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
      <Pressable onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>
    ),
    SettingsSection: ({ title, children }: { title?: string; children: React.ReactNode }) => (
      <View>
        {title ? <Text testID="section-title">{title}</Text> : null}
        {children}
      </View>
    ),
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

describe('AccountScreen referral section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState.user = mockUser;
    mockAuthState.sessionCookie = 'session-cookie';
    mockAuthState.isGuest = false;
    mockUsageStoreState.usage = mockUsage;
  });

  it('shows Referral between Usage and Preferences', () => {
    const { getAllByTestId } = render(<AccountScreen />);

    const titles = getAllByTestId('section-title').map((node) => node.props.children as string);

    expect(titles.slice(titles.indexOf('Usage'), titles.indexOf('Preferences') + 1)).toEqual([
      'Usage',
      'Referral',
      'Preferences',
    ]);
  });

  it('opens the referral screen', () => {
    const { getByText } = render(<AccountScreen />);

    fireEvent.press(getByText('Referral Code'));

    expect(mockRouterPush).toHaveBeenCalledWith('/(account)/referral');
  });

  it('shows Referral to guests', () => {
    mockAuthState.user = null;
    mockAuthState.sessionCookie = null;
    mockAuthState.isGuest = true;
    mockUsageStoreState.usage = null;

    const { getByText } = render(<AccountScreen />);

    expect(getByText('Referral Code')).toBeTruthy();
  });
});
