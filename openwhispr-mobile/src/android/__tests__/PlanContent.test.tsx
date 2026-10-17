import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { useUsageStore } from '@/store/useUsageStore';
import { restoreAndroidPurchases, useAndroidBillingStatus } from '../billing';
import { PlanContent } from '../PlanContent';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/lib/superwall', () => ({ SUPERWALL_PLACEMENTS: { accountBillingOpen: 'billing' } }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const english = require('../../locales/en/translation.json').android;
      if (key === 'cloudAllowance' || key === 'cloudUnlimited') {
        return (english[key] ?? key).replace(
          /{{(\w+)}}/g,
          (_: string, name: string) => values?.[name] ?? '',
        );
      }
      return key;
    },
  }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({ user: { id: 'a', isAnonymous: false } })),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: require('zustand').create(() => ({
    usage: null,
    isLoading: false,
    load: jest.fn(async () => ({ status: 'loaded' })),
  })),
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/data/remote/billingApi', () => ({ createStripeBillingPortalSession: jest.fn() }));
jest.mock('../billing', () => ({
  useAndroidBillingStatus: require('zustand').create(() => ({ accounts: {} })),
  restoreAndroidPurchases: jest.fn(async () => 'payment-pending'),
  refreshAndroidBillingAccess: jest.fn(),
}));
jest.mock('../ui', () => {
  const { Pressable, Text } = require('react-native');
  const Button = ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    require('react').createElement(
      Pressable,
      { onPress, disabled, accessibilityRole: 'button', accessibilityLabel: label },
      require('react').createElement(Text, null, label),
    );
  return {
    Card: ({ children }: { children: React.ReactNode }) => children,
    Button,
    Row: ({ title, onPress }: { title: string; onPress: () => void }) =>
      require('react').createElement(Button, { label: title, onPress }),
    styles: {},
  };
});
beforeEach(() => {
  jest.clearAllMocks();
  (useUsageStore.getState().load as jest.Mock).mockResolvedValue({ status: 'loaded' });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  useUsageStore.setState({
    isLoading: false,
    usage: {
      billingUserId: 'billing-a',
      isSubscribed: false,
      wordsRemaining: 2000,
      limit: 2000,
      wordsUsed: 0,
      plan: 'free',
      status: 'active',
      isTrial: false,
      trialDaysLeft: null,
      currentPeriodEnd: null,
      billingInterval: null,
      resetAt: '2026-11-01T00:00:00Z',
      entitlementSources: { provider: false, personal: false, workspaceIds: [] },
    },
  });
  useAndroidBillingStatus.setState({ accounts: { 'billing-a': 'payment-pending' } });
});
it('keeps unknown access out of checkout and offers a retry after loading fails', async () => {
  useUsageStore.setState({ usage: null });
  const load = useUsageStore.getState().load as jest.Mock;
  load.mockResolvedValueOnce({ status: 'failed', error: new Error('offline') });
  render(<PlanContent />);
  expect(screen.getByText('planChecking')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'upgrade' })).toBeNull();
  expect(screen.queryByText('proBody')).toBeNull();
  await waitFor(() => expect(screen.getByText('planUnavailable')).toBeTruthy());
  fireEvent.press(screen.getByRole('button', { name: 'refreshAccess' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  act(() => {
    useUsageStore.setState({
      usage: {
        isSubscribed: true,
        plan: 'business',
      } as NonNullable<ReturnType<typeof useUsageStore.getState>['usage']>,
    });
  });
  expect(screen.getByText('OpenWhispr Business')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'upgrade' })).toBeNull();
});
it.each(['payment-pending', 'access-pending', 'checking'] as const)(
  'offers Play and help while %s without launching another checkout',
  async (status) => {
    useAndroidBillingStatus.setState({ accounts: { 'billing-a': status } });
    render(<PlanContent />);
    expect(screen.queryByRole('button', { name: 'upgrade' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'managePlay' }));
    await waitFor(() =>
      expect(Linking.openURL).toHaveBeenCalledWith(
        'https://play.google.com/store/account/subscriptions',
      ),
    );
    fireEvent.press(screen.getByRole('button', { name: 'support' }));
    expect(router.push).toHaveBeenCalledWith('/(account)/help');
  },
);
it('explains the unresolved payment after an empty restore', async () => {
  render(<PlanContent />);
  fireEvent.press(screen.getByRole('button', { name: 'restorePurchases' }));
  await waitFor(() => expect(restoreAndroidPurchases).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(Alert.alert).toHaveBeenCalledWith('restorePurchases', 'billingPaymentPending'),
  );
});
it('does not show Play management for a free account without a pending payment', () => {
  useAndroidBillingStatus.setState({ accounts: {} });
  render(<PlanContent />);
  expect(screen.queryByRole('button', { name: 'managePlay' })).toBeNull();
  expect(screen.getByRole('button', { name: 'upgrade' })).toBeTruthy();
});

it('shows unlimited cloud words for the subscribed API sentinel', () => {
  useUsageStore.setState({
    usage: {
      ...useUsageStore.getState().usage!,
      isSubscribed: true,
      plan: 'business',
      limit: -1,
      wordsRemaining: -1,
    },
  });
  render(<PlanContent />);
  expect(screen.getByText('Unlimited words')).toBeTruthy();
  expect(screen.getByText('OpenWhispr Business')).toBeTruthy();
  expect(screen.queryByText('proBody')).toBeNull();
  expect(screen.queryByText('proNote')).toBeNull();
  expect(screen.queryByText(/-1/)).toBeNull();
});
it.each([2000, 0])('keeps the finite free allowance when %s words remain', (wordsRemaining) => {
  useUsageStore.setState({
    usage: { ...useUsageStore.getState().usage!, wordsRemaining },
  });
  render(<PlanContent />);
  expect(
    screen.getByText(`${wordsRemaining.toLocaleString()} of 2,000 words available`),
  ).toBeTruthy();
  expect(screen.queryByText('Unlimited words')).toBeNull();
});
