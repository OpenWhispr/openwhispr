import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';
import { router } from 'expo-router';
import type { UsageInfo } from '@/android/remote/usageApi';

jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: async () => true,
  fadeTheme: jest.fn(),
}));
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values && Object.keys(values).length ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en', dir: () => 'ltr' },
  }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({
    user: { id: 'a', isAnonymous: false },
    sessionCookie: 'session-a',
  })),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useUsageStore.android', () => ({
  useUsageStore: require('zustand').create(() => ({
    usage: null,
    isLoading: false,
    sessionRejected: false,
    load: jest.fn(async () => ({ status: 'loaded' })),
  })),
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore.android'));
const mockRegister = jest.fn(async () => undefined);
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegister }),
}));
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { accountBillingOpen: 'billing', cloudUsageLimitReached: 'limit' },
  buildUsageGateParams: () => ({ wordsRemaining: 0 }),
}));
jest.mock('@/data/remote/billingApi', () => ({
  createStripeBillingPortalSession: jest.fn(async () => 'https://billing.example/portal'),
}));
jest.mock('../billing', () => ({
  useAndroidBillingStatus: require('zustand').create(() => ({ accounts: {}, since: {} })),
  restoreAndroidPurchases: jest.fn(async () => 'none'),
  refreshAndroidBillingAccess: jest.fn(async () => undefined),
}));
const mockPrices = {
  prices: { annual: '$80.00', annualPerMonth: '$6.58', monthly: '$8.00' } as Record<
    string,
    string
  > | null,
  unavailable: false,
  loading: false,
  retry: jest.fn(),
};
jest.mock('../plan/prices', () => ({ usePlayPrices: () => mockPrices }));

import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore.android';
import { ThemeProvider } from '../ThemeProvider';
import { useSettingsToast } from '../settings/kit';
import {
  refreshAndroidBillingAccess,
  restoreAndroidPurchases,
  useAndroidBillingStatus,
} from '../billing';
import { PlanContent } from '../PlanContent';

function usage(change: Partial<UsageInfo> = {}): UsageInfo {
  return {
    billingUserId: 'billing-a',
    isSubscribed: false,
    wordsRemaining: 1927,
    limit: 2000,
    wordsUsed: 73,
    plan: 'free',
    status: 'active',
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    resetAt: 'rolling',
    entitlementSources: { provider: false, personal: false, workspaceIds: [] },
    ...change,
  };
}
const playPro = (change: Partial<UsageInfo> = {}) =>
  usage({
    isSubscribed: true,
    plan: 'pro',
    limit: -1,
    wordsRemaining: -1,
    currentPeriodEnd: '2027-11-24T10:00:00Z',
    billingInterval: 'annual',
    entitlementSources: {
      provider: true,
      personal: false,
      providerStore: 'play_store',
      workspaceIds: [],
    },
    ...change,
  });

const show = (props: React.ComponentProps<typeof PlanContent> = {}) =>
  render(
    <ThemeProvider>
      <PlanContent {...props} />
    </ThemeProvider>,
  );
const state = () =>
  screen.UNSAFE_root.findAll((n: { props: { testID?: string } }) =>
    /^plan-/.test(n.props.testID ?? ''),
  )[0];
const kind = () => state().props.testID.replace('plan-', '');

const originalPlatform = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  useAuthStore.setState({
    user: { id: 'a', isAnonymous: false },
    sessionCookie: 'session-a',
  } as never);
  useUsageStore.setState({ isLoading: false, sessionRejected: false, usage: usage() });
  (useUsageStore.getState().load as jest.Mock).mockResolvedValue({ status: 'loaded' });
  useAndroidBillingStatus.setState({ accounts: {}, since: {} });
  useSettingsToast.setState({ message: '', id: 0 });
  mockPrices.prices = { annual: '$80.00', annualPerMonth: '$6.58', monthly: '$8.00' };
  mockPrices.unavailable = false;
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => {
  Platform.OS = originalPlatform;
});

it('A · free: the plan, the meter, what Pro adds and the cancel line', () => {
  show();
  expect(kind()).toBe('free');
  expect(screen.getByText('chipYourPlan')).toBeTruthy();
  expect(screen.getByText('73 / 2,000')).toBeTruthy();
  expect(screen.getByText('addDevices')).toBeTruthy();
  expect(screen.getByText('cancelAnytime')).toBeTruthy();
  // The allowance is a rolling 7 days: no reset day, and never "N left".
  expect(screen.getByText('rollingAllowance')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'seeProPlans' }));
  expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ placement: 'billing' }));
});

it('B · out of words opens the out-of-words paywall', () => {
  useUsageStore.setState({ usage: usage({ wordsUsed: 2000, wordsRemaining: 0 }) });
  show();
  expect(kind()).toBe('free-out');
  expect(screen.getByText('freeOutBody')).toBeTruthy();
  expect(screen.queryByText('addDevices')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'goUnlimited' }));
  expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ placement: 'limit' }));
});

it('the bubble’s Go Pro opens the out-of-words paywall over the screen once', () => {
  useUsageStore.setState({ usage: usage({ wordsUsed: 2000, wordsRemaining: 0 }) });
  const view = show({ openPaywall: 'limit' });
  view.rerender(
    <ThemeProvider>
      <PlanContent openPaywall="limit" />
    </ThemeProvider>,
  );
  expect(mockRegister).toHaveBeenCalledTimes(1);
  expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ placement: 'limit' }));
});

it('L · Restore that finds nothing says so at the bottom', async () => {
  show();
  fireEvent.press(screen.getByRole('button', { name: 'restorePurchases' }));
  await waitFor(() => expect(restoreAndroidPurchases).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useSettingsToast.getState().message).toBe('noPurchase'));
});

it('K · Google Play unavailable offers Try again and no checkout', () => {
  mockPrices.prices = null;
  mockPrices.unavailable = true;
  show();
  expect(screen.getByText('storeUnavailable')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'seeProPlans' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'tryAgain' }));
  expect(mockPrices.retry).toHaveBeenCalled();
});

it('J · signed out asks to sign in first', () => {
  useAuthStore.setState({ user: null, sessionCookie: null } as never);
  show();
  expect(kind()).toBe('signed-out');
  expect(screen.queryByText('73 / 2,000')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'signIn' }));
  expect(router.push).toHaveBeenCalledWith('/auth?reason=plan');
});

it('hides a cached plan after the session is rejected', () => {
  useUsageStore.setState({ sessionRejected: true });
  show();
  expect(screen.queryByText('73 / 2,000')).toBeNull();
  expect(screen.queryByRole('button', { name: 'seeProPlans' })).toBeNull();
  expect(screen.getByRole('button', { name: 'signIn' })).toBeTruthy();
});

it('keeps unknown access out of checkout and retries after loading fails', async () => {
  useUsageStore.setState({ usage: null });
  const load = useUsageStore.getState().load as jest.Mock;
  load.mockResolvedValueOnce({ status: 'failed', error: new Error('offline') });
  show();
  expect(screen.getByText('checkingPlan')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('planUnavailable')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'seeProPlans' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'tryAgain' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

describe('confirming a purchase', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('B3 → B3b: Unlocking Pro becomes "Pro is on its way" after 30 s', () => {
    useAndroidBillingStatus.setState({
      accounts: { 'billing-a': 'access-pending' },
      since: { 'billing-a': Date.now() },
    });
    show();
    expect(kind()).toBe('confirming');
    expect(screen.getByText('unlockingTitle')).toBeTruthy();
    // Only Get help while it runs: no Restore, no second checkout.
    expect(screen.queryByRole('button', { name: 'restorePurchases' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'seeProPlans' })).toBeNull();
    act(() => jest.advanceTimersByTime(30_100));
    expect(kind()).toBe('on-its-way');
    fireEvent.press(screen.getByRole('button', { name: 'checkAgain' }));
    expect(refreshAndroidBillingAccess).toHaveBeenCalled();
  });

  it('times the 30 s from the purchase, not from when the screen opened', () => {
    show();
    expect(kind()).toBe('free');
    // The paywall stays open a minute before the purchase goes through.
    act(() => jest.advanceTimersByTime(60_000));
    act(() =>
      useAndroidBillingStatus.setState({
        accounts: { 'billing-a': 'checking' },
        since: { 'billing-a': Date.now() },
      }),
    );
    expect(kind()).toBe('confirming');
    act(() => jest.advanceTimersByTime(30_100));
    expect(kind()).toBe('on-its-way');
  });

  it('a wait restored from an earlier run reads as the longer one at once', () => {
    useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'access-pending' }, since: {} });
    show();
    expect(kind()).toBe('on-its-way');
  });

  it('B4 · payment pending offers Google Play and help', () => {
    useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
    show();
    expect(kind()).toBe('payment-pending');
    fireEvent.press(screen.getByRole('button', { name: 'openGooglePlay' }));
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://play.google.com/store/account/subscriptions',
    );
    fireEvent.press(screen.getByRole('button', { name: 'getHelp' }));
    expect(router.push).toHaveBeenCalledWith('/(account)/help');
  });

  it('B5 · unlocking says so in a bottom toast', () => {
    useAndroidBillingStatus.setState({
      accounts: { 'billing-a': 'access-pending' },
      since: { 'billing-a': Date.now() },
    });
    show();
    act(() => {
      useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'idle' }, since: {} });
      useUsageStore.setState({ usage: playPro() });
    });
    expect(kind()).toBe('pro-play');
    expect(useSettingsToast.getState().message).toBe('proToast');
  });
});

it('C · Pro on Google Play: renewal date, Play price and management', () => {
  useUsageStore.setState({ usage: playPro() });
  show();
  expect(kind()).toBe('pro-play');
  // Pro cards say YOUR PLAN, never Pro twice.
  expect(screen.getByText('chipYourPlan')).toBeTruthy();
  expect(screen.queryByText('chipPro')).toBeNull();
  expect(screen.getByText(/^renewsPrice:.*"price":"priceYear:/)).toBeTruthy();
  expect(screen.getByText('unlimited')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'manageSubscription' }));
  expect(Linking.openURL).toHaveBeenCalled();
  expect(useSettingsToast.getState().message).toBe('');
});

it('D · cancelled in Play keeps Pro until the period ends', () => {
  useUsageStore.setState({ usage: playPro({ status: 'canceled' }) });
  show();
  expect(kind()).toBe('pro-play-cancelled');
  expect(screen.getByText(/^cancelledTitle:/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'keepPro' })).toBeTruthy();
});

it('E · a payment problem asks to fix it in Play', () => {
  useUsageStore.setState({ usage: playPro({ status: 'past_due' }) });
  show();
  expect(kind()).toBe('pro-play-problem');
  fireEvent.press(screen.getByRole('button', { name: 'fixPayment' }));
  expect(Linking.openURL).toHaveBeenCalled();
});

it('G · billed on the web opens the billing portal', async () => {
  useUsageStore.setState({
    usage: playPro({
      currentPeriodEnd: '2027-02-03T00:00:00Z',
      entitlementSources: { provider: false, personal: true, workspaceIds: [] },
    }),
  });
  show();
  expect(kind()).toBe('pro-web');
  fireEvent.press(screen.getByRole('button', { name: 'manageWeb' }));
  await waitFor(() =>
    expect(Linking.openURL).toHaveBeenCalledWith('https://billing.example/portal'),
  );
});

it('H and I · workspace and App Store plans have nothing to buy', () => {
  useUsageStore.setState({
    usage: playPro({
      plan: 'business',
      entitlementSources: { provider: false, personal: false, workspaceIds: ['w1'] },
    }),
  });
  const view = show();
  expect(kind()).toBe('business-workspace');
  expect(screen.queryByRole('button', { name: 'seeProPlans' })).toBeNull();
  view.unmount();
  useUsageStore.setState({
    usage: playPro({
      entitlementSources: {
        provider: true,
        personal: false,
        providerStore: 'app_store',
        workspaceIds: [],
      },
    }),
  });
  show();
  expect(kind()).toBe('pro-app-store');
  expect(screen.getByText('billedByApple')).toBeTruthy();
});

it.each(['account switch', 'unmount'] as const)(
  'discards a late Restore result after %s',
  async (change) => {
    let finish!: (result: string) => void;
    (restoreAndroidPurchases as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const view = show();
    fireEvent.press(screen.getByRole('button', { name: 'restorePurchases' }));
    act(() => {
      if (change === 'unmount') view.unmount();
      else useAuthStore.setState({ user: { id: 'b', isAnonymous: false } } as never);
    });
    await act(async () => finish('restored'));
    expect(useSettingsToast.getState().message).toBe('');
  },
);
