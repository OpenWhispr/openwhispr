import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';
import StyleScreen from '../StyleScreen';

jest.mock('@react-navigation/native', () => ({ useScrollToTop: () => undefined }));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#ffffff' }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => true }));
jest.mock('@/sync/useSyncStore', () => ({ useSyncStore: () => ({}) }));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => false }));
jest.mock('@/android/insights', () => ({
  setInsightsSyncConsent: jest.fn(),
  useInsights: () => false,
}));
jest.mock('@/android/pipeline', () => ({ applyHistoryRetention: jest.fn(async () => {}) }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('../ui', () => {
  const { Pressable, Text } = require('react-native');
  const Button = ({ label, onPress, disabled }: any) =>
    require('react').createElement(
      Pressable,
      { onPress, disabled, accessibilityRole: 'button', accessibilityLabel: label },
      require('react').createElement(Text, null, label),
    );
  return {
    Page: ({ children }: any) => children,
    Card: ({ children }: any) => children,
    Button,
    Row: ({ title, ...props }: any) =>
      require('react').createElement(Button, { label: title, ...props }),
    styles: {},
    palette: {},
  };
});
const mockSave = jest.fn(async (change: object) => {
  useConfigStore.setState((state) => ({ config: { ...state.config!, ...change }, error: null }));
});
beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockReset().mockImplementation(async (change) => {
    useConfigStore.setState((state) => ({ config: { ...state.config!, ...change }, error: null }));
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  useConfigStore.setState({
    config: {
      androidStyleContext: 'personal',
      androidStyleTones: { work: 'formal' },
      androidHistoryDays: 30,
    } as any,
    error: null,
    updateConfig: mockSave,
  });
});
it('keeps the tone picker and previous selection after a swallowed persistence failure', async () => {
  mockSave.mockImplementationOnce(async () => {
    useConfigStore.setState({ error: 'disk full' });
  });
  render(<StyleScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'default' }));
  await act(async () => {
    fireEvent.press(screen.getByRole('radio', { name: 'casual' }));
  });
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'disk full');
  expect(screen.getByRole('radio', { name: 'default' }).props.accessibilityState.checked).toBe(
    true,
  );
  expect(useConfigStore.getState().config?.androidStyleTones).toEqual({ work: 'formal' });
  await act(async () => {
    fireEvent.press(screen.getByRole('radio', { name: 'casual' }));
  });
  expect(screen.queryByRole('radio', { name: 'casual' })).toBeNull();
  expect(useConfigStore.getState().config?.androidStyleTones).toEqual({
    work: 'formal',
    personal: 'casual',
  });
});
it('prevents overlapping tone saves and retains other contexts', async () => {
  let resolve!: () => void;
  mockSave.mockImplementationOnce(
    (change) =>
      new Promise<void>((done) => {
        resolve = () => {
          useConfigStore.setState((state) => ({ config: { ...state.config!, ...change } }));
          done();
        };
      }),
  );
  render(<StyleScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'default' }));
  const first = screen.getByRole('radio', { name: 'casual' });
  const second = screen.getByRole('radio', { name: 'excited' });
  act(() => {
    fireEvent.press(first);
    fireEvent.press(second);
  });
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('savingPreference')).toBeTruthy();
  await act(async () => {
    resolve();
  });
  expect(useConfigStore.getState().config?.androidStyleTones).toEqual({
    work: 'formal',
    personal: 'casual',
  });
});
it('preserves the current context if saving a different context fails', async () => {
  mockSave.mockImplementationOnce(async () => {
    useConfigStore.setState({ error: 'disk full' });
  });
  render(<StyleScreen />);
  await act(async () => {
    fireEvent.press(screen.getByRole('tab', { name: 'work' }));
  });
  expect(screen.getByRole('tab', { name: 'personal' }).props.accessibilityState.selected).toBe(
    true,
  );
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'disk full');
});
