import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, useColorScheme } from 'react-native';

jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: async () => true,
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({ useScrollToTop: () => undefined }));
jest.mock('react-native-svg', () => ({ SvgXml: () => null }));
jest.mock('expo-image', () => ({ Image: require('react-native').View }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({
    user: { id: 'member', email: 'member@example.com', isAnonymous: false },
    sessionCookie: 'session=member',
  })),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/lib/referralApi', () => ({
  fetchReferralStats: jest.fn(async () => ({
    referralCode: 'test',
    referralLink: 'https://openwhispr.com/r/test',
    totalMonthsEarned: 2,
    completedReferrals: 2,
  })),
  fetchReferralInvites: jest.fn(async () => [
    { id: '1', recipientEmail: 'sam@example.com', status: 'converted' },
  ]),
  sendReferralInvite: jest.fn(),
}));
jest.mock('@/android/lib/referralApi', () => jest.requireMock('@/lib/referralApi'));
jest.mock('@/store/useUsageStore.android', () => ({
  useUsageStore: require('zustand').create(() => ({
    usage: null,
    isLoading: false,
    sessionRejected: false,
    load: jest.fn(async () => ({ status: 'loaded' })),
  })),
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore.android'));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/android/shared/hooks/useSuperwallGate', () =>
  jest.requireMock('@/hooks/useSuperwallGate'),
);
jest.mock('@/lib/superwall', () => ({ SUPERWALL_PLACEMENTS: { accountBillingOpen: 'billing' } }));
jest.mock('@/android/shared/lib/superwall', () => jest.requireMock('@/lib/superwall'));
jest.mock('@/data/remote/billingApi', () => ({ createStripeBillingPortalSession: jest.fn() }));
jest.mock('@/android/shared/data/remote/billingApi', () =>
  jest.requireMock('@/data/remote/billingApi'),
);
jest.mock('../billing', () => ({
  useAndroidBillingStatus: require('zustand').create(() => ({ accounts: {} })),
  restoreAndroidPurchases: jest.fn(),
  refreshAndroidBillingAccess: jest.fn(),
}));

import { useAuthStore } from '@/store/useAuthStore';
import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { PlanContent } from '../PlanContent';
import LicensesScreen from '@/screens/LicensesScreen.android';
import ReferralScreen from '@/screens/ReferralScreen.android';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection.android';

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const textColour = (text: string) => flat(screen.getByText(text).props.style).color;
function fillOf(node: ReactTestInstance) {
  for (let n: ReactTestInstance | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}

function inTheme(scheme: 'light' | 'dark', node: () => React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{node()}</ThemeProvider>);
}

const originalPlatform = Platform.OS;
beforeEach(() => {
  Platform.OS = 'android';
  mockScheme.mockReturnValue('light');
  useAuthStore.setState({
    user: { id: 'member', email: 'member@example.com', isAnonymous: false },
    sessionCookie: 'session=member',
  } as never);
});
afterEach(() => {
  Platform.OS = originalPlatform;
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('plan & privacy screens in %s', (scheme, tokens) => {
  it('draws the plan title, body and note from the palette', () => {
    useAuthStore.setState({ user: null, sessionCookie: null } as never);
    inTheme(scheme, () => <PlanContent />);
    expect(textColour('signInTitle')).toBe(tokens.ink);
    expect(textColour('signInBody')).toBe(tokens.secondary);
  });

  it('draws the licence rows on the page canvas', () => {
    inTheme(scheme, () => <LicensesScreen />);
    expect(textColour('MIT · © Useful Sensors, Inc. (dba Moonshine AI)')).toBe(tokens.secondary);
    const page = screen.UNSAFE_root.findAll(
      (n: ReactTestInstance) => typeof n.type === 'string' && n.props.edges,
    )[0];
    expect(flat(page.props.style)).toMatchObject({ backgroundColor: tokens.canvas });
  });

  it('draws the referral card, count and invite tag from the palette', async () => {
    inTheme(scheme, () => <ReferralScreen />);
    const count = await screen.findByText('2');
    expect(flat(count.props.style).color).toBe(tokens.accent);
    expect(fillOf(screen.getByText('Months banked'))).toBe(tokens.surface);
    expect(fillOf(screen.getByText('Joined'))).toBe(tokens.successFill);
    expect(screen.getByPlaceholderText('friend@example.com').props.placeholderTextColor).toBe(
      tokens.tertiary,
    );
  });

  it('draws the shared settings section rows from the palette', () => {
    inTheme(scheme, () => (
      <SettingsSection title="Section">
        <SettingsRow icon="gear" title="Row" description="Details" onPress={() => {}} />
      </SettingsSection>
    ));
    expect(textColour('Row')).toBe(tokens.ink);
    expect(textColour('Details')).toBe(tokens.secondary);
    expect(fillOf(screen.getAllByTestId('glyph')[0])).toBe(tokens.tile);
  });
});

it('repaints the referral screen in place on a live switch, keeping the typed email', async () => {
  const tree = () => (
    <ThemeProvider>
      <ReferralScreen />
    </ThemeProvider>
  );
  mockScheme.mockReturnValue('light');
  const { rerender } = render(tree());
  const input = await screen.findByPlaceholderText('friend@example.com');
  fireEvent.changeText(input, 'pat@example.com');
  const card = screen.getByText('Months banked');
  expect(fillOf(card)).toBe(lightTheme.surface);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    rerender(tree());
  });
  expect(screen.getByText('Months banked')).toBe(card);
  expect(fillOf(card)).toBe(darkTheme.surface);
  expect(screen.getByPlaceholderText('friend@example.com').props.value).toBe('pat@example.com');
});
