import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useUsageStore } from '@/store/useUsageStore';
import AndroidAccount from '../AccountScreen.android';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({
    user: { id: 'account-a', name: 'Test', email: 'test@example.com', isAnonymous: false },
  })),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: require('zustand').create(() => ({
    usage: null,
    load: jest.fn(async () => undefined),
  })),
}));
jest.mock('@/android/ui', () => ({
  Page: ({ children }: { children: React.ReactNode }) => children,
  Section: ({ children }: { children: React.ReactNode }) => children,
  Row: ({ title, detail }: { title: string; detail?: string }) =>
    require('react').createElement(require('react-native').Text, null, title, detail),
  styles: {},
}));

beforeEach(() => {
  jest.clearAllMocks();
  useUsageStore.setState({ usage: null });
});

it('loads account access without presenting an unknown subscription as free', async () => {
  render(<AndroidAccount />);
  await waitFor(() => expect(useUsageStore.getState().load).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/proBody/)).toBeNull();
  act(() => {
    useUsageStore.setState({
      usage: { isSubscribed: true } as NonNullable<
        ReturnType<typeof useUsageStore.getState>['usage']
      >,
    });
  });
  expect(screen.getByText(/cloudUnlimited/)).toBeTruthy();
  expect(screen.queryByText(/proBody/)).toBeNull();
});

it('shows the upgrade explanation only after free access is confirmed', () => {
  useUsageStore.setState({
    usage: { isSubscribed: false } as NonNullable<
      ReturnType<typeof useUsageStore.getState>['usage']
    >,
  });
  render(<AndroidAccount />);
  expect(screen.getByText(/proBody/)).toBeTruthy();
});
