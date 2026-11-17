import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Alert } from 'react-native';
import { useUsageStore } from '@/store/useUsageStore';
import { useConfigStore } from '@/store/useConfigStore';
import { requestSync } from '@/sync/syncEngine';
import SettingsScreen from '../AccountScreen.android';

const mockPush = jest.fn();
const mockSignOut = jest.fn();
let mockUser: { id: string; name?: string; email?: string; isAnonymous: boolean } | null;
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), canGoBack: () => true },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    getStatus: () => ({ overlay: true }),
    setEnabled: jest.fn(),
    openSettings: jest.fn(),
  },
}));
jest.mock('@/android/settings/permissions', () => ({
  usePermissions: () => ({ status: { enabled: false }, offCount: 1, refresh: jest.fn() }),
  requestRuntime: jest.fn(async () => true),
}));
jest.mock('@/android/settings/bubbleAppearance', () => ({
  useBubbleLook: (selector: (state: { opacity: number }) => unknown) => selector({ opacity: 0.8 }),
  applyBubbleLook: jest.fn(),
  sizeLabel: () => 'medium',
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: object) => unknown) =>
    selector({ user: mockUser, isGuest: false, signOut: mockSignOut }),
}));
jest.mock('@/lib/accountAccess', () => ({
  requiresRealAccount: (user: { isAnonymous?: boolean } | null) => !user || user.isAnonymous,
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: require('zustand').create(() => ({
    usage: null,
    load: jest.fn(async () => undefined),
  })),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: { activeMode: string }) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: () => ({
    status: 'idle',
    lastSyncAt: null,
    policyBlocked: false,
    subscriptionRequired: false,
  }),
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn(async () => undefined) }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const updateConfig = jest.fn(async (change: object) => {
  useConfigStore.setState((state) => ({ config: { ...state.config!, ...change } }));
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
  mockUser = { id: 'a', name: 'Alex Morgan', email: 'alex@example.com', isAnonymous: false };
  useUsageStore.setState({ usage: null });
  useConfigStore.setState({ config: {}, error: null, updateConfig } as never);
});

const usage = (change: object) =>
  ({
    wordsUsed: 1,
    wordsRemaining: 1999,
    limit: 2000,
    isSubscribed: false,
    isTrial: false,
    ...change,
  }) as never;

it('never shows an unknown plan as Free', () => {
  render(<SettingsScreen />);
  expect(useUsageStore.getState().load).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('free')).toBeNull();
  expect(screen.queryByText('wordsThisWeek')).toBeNull();
  act(() => useUsageStore.setState({ usage: usage({ isSubscribed: true }) }));
  expect(screen.getAllByText('pro').length).toBeGreaterThan(0);
  expect(screen.getByText('unlimitedWords')).toBeTruthy();
});

it('shows this week’s words for a free plan', () => {
  useUsageStore.setState({ usage: usage({}) });
  render(<SettingsScreen />);
  expect(screen.getByText('1 / 2,000')).toBeTruthy();
  expect(screen.getByText('wordsLeft')).toBeTruthy();
});

it('says how many permissions are still off', () => {
  render(<SettingsScreen />);
  expect(screen.getByText('toTurnOn')).toBeTruthy();
});

it('asks a signed-out person to sign in before backing up', () => {
  mockUser = null;
  render(<SettingsScreen />);
  expect(screen.getByText('localWorkspace')).toBeTruthy();
  fireEvent.press(screen.getByRole('switch', { name: 'cloudBackup' }));
  expect(Alert.alert).toHaveBeenCalledWith(
    'backupSignInTitle',
    'backupSignInBody',
    expect.any(Array),
  );
  expect(updateConfig).not.toHaveBeenCalled();
  expect(screen.queryByText('signOut')).toBeNull();
});

it('turns backup on and starts a sync without waiting for it', async () => {
  render(<SettingsScreen />);
  await act(async () => fireEvent.press(screen.getByRole('switch', { name: 'cloudBackup' })));
  expect(useConfigStore.getState().config?.cloudBackupEnabled).toBe(true);
  expect(requestSync).toHaveBeenCalledWith('manual');
});

it('confirms before signing out', () => {
  render(<SettingsScreen />);
  fireEvent.press(screen.getByText('signOut'));
  expect(mockSignOut).not.toHaveBeenCalled();
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  act(() => buttons.find((button) => button.style === 'destructive')!.onPress!());
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});
