import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Linking } from 'react-native';
import { NotificationsStep } from '../NotificationsStep';
import { KeyboardIntroStep } from '../KeyboardIntroStep';
import { MicrophoneStep } from '../MicrophoneStep';
import { GraduationStep } from '../GraduationStep';
import { KeyboardSwitchStep } from '../KeyboardSwitchStep';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View, Text: require('react-native').Text },
  Easing: { out: jest.fn(), cubic: jest.fn() },
  useAnimatedStyle: () => ({}),
  useSharedValue: () => ({ value: 0 }),
  withDelay: jest.fn(),
  withRepeat: jest.fn(),
  withSequence: jest.fn(),
  withTiming: jest.fn(),
}));

let mockHeartbeatConfirmation: () => void;
jest.mock('@/hooks/useKeyboardHeartbeat', () => ({
  useKeyboardHeartbeat: (onConfirmed: () => void) => {
    mockHeartbeatConfirmation = onConfirmed;
    return false;
  },
}));

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/onboarding/AnimatedKeyboardPreview', () => ({
  AnimatedKeyboardPreview: () => null,
}));
jest.mock('@/components/onboarding/FullAccessReasons', () => ({ FullAccessReasons: () => null }));
jest.mock('@/components/onboarding/InstructionOverlay', () => ({ InstructionOverlay: () => null }));
jest.mock('@/lib/keyboardPipTutorial', () => ({
  startKeyboardPipTutorial: jest.fn(),
  stopKeyboardPipTutorial: jest.fn(),
}));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({
    AudioModule: {
      getRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    },
  }),
}));
jest.mock('../../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { armWarmMic: jest.fn() },
}));
const mockNext = jest.fn();
const mockFinish = jest.fn();
const mockPermission = jest.fn();
const mockKeyboardInstalled = jest.fn();
const mockIsInstalled = jest.fn();
const mockStatus = jest.fn();
const mockRequest = jest.fn();
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (state: unknown) => unknown) =>
    selector({
      goNext: mockNext,
      finish: mockFinish,
      setPermissionGranted: mockPermission,
      setKeyboardInstalled: mockKeyboardInstalled,
    }),
  getStepProgress: () => ({ current: 1, total: 8 }),
}));
jest.mock('@/lib/keyboardInstallation', () => ({ isKeyboardInstalled: () => mockIsInstalled() }));
jest.mock('@/lib/notifications', () => ({
  getNotificationStatus: () => mockStatus(),
  requestNotifications: () => mockRequest(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockNext.mockResolvedValue(undefined);
  mockFinish.mockResolvedValue(undefined);
  mockPermission.mockResolvedValue(undefined);
  mockKeyboardInstalled.mockResolvedValue(undefined);
  mockIsInstalled.mockReturnValue(false);
  mockStatus.mockResolvedValue('undetermined');
  mockRequest.mockResolvedValue('denied');
  jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('accepts notification denial without showing another permission screen', async () => {
  const screen = render(<NotificationsStep />);
  fireEvent.press(await screen.findByText('Allow notifications'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledWith('notifications'));
  expect(mockPermission).toHaveBeenCalledWith('notifications', false);
  expect(screen.queryByText('Notifications are off')).toBeNull();
});

it('retries saving notification denial without asking for permission again', async () => {
  mockStatus.mockResolvedValueOnce('denied');
  mockNext.mockRejectedValueOnce(new Error('Could not save progress'));
  const screen = render(<NotificationsStep />);
  fireEvent.press(await screen.findByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
  expect(mockRequest).not.toHaveBeenCalled();
  expect(screen.queryByText('Allow notifications')).toBeNull();
});

it('does not keep polling after detecting the keyboard on Settings return', async () => {
  jest.useFakeTimers();
  let onState: ((state: 'background' | 'active') => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onState = listener;
    return { remove: jest.fn() };
  });
  render(<KeyboardIntroStep />);
  act(() => onState?.('background'));
  mockIsInstalled.mockReturnValue(true);
  await act(async () => {
    onState?.('active');
  });
  await act(async () => {
    jest.advanceTimersByTime(1200);
  });
  expect(mockNext).toHaveBeenCalledTimes(1);
  expect(mockNext).toHaveBeenCalledWith('keyboard-intro');
});

it('finishes setup before launching an external app', async () => {
  let resolveFinish: () => void = () => undefined;
  mockFinish.mockReturnValue(
    new Promise<void>((resolve) => {
      resolveFinish = resolve;
    }),
  );
  const screen = render(<GraduationStep />);
  fireEvent.press(screen.getByLabelText('Messages'));
  expect(Linking.openURL).not.toHaveBeenCalled();
  await act(async () => resolveFinish());
  await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('sms:'));
  expect(mockFinish).toHaveBeenCalledTimes(1);
});

it('does not launch an app when persisting completion fails', async () => {
  mockFinish.mockRejectedValueOnce(new Error('Could not finish setup'));
  const screen = render(<GraduationStep />);
  fireEvent.press(screen.getByLabelText('Messages'));
  expect(await screen.findByText('Could not finish setup')).toBeTruthy();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

it('allows a granted microphone step to retry a failed progress save', async () => {
  mockNext.mockRejectedValueOnce(new Error('Keychain unavailable'));
  const screen = render(<MicrophoneStep />);
  fireEvent.press(await screen.findByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
});

it('shows a retry if detected keyboard continuation cannot save progress', async () => {
  mockNext.mockRejectedValueOnce(new Error('Could not save keyboard progress'));
  const screen = render(<KeyboardSwitchStep />);
  await act(async () => mockHeartbeatConfirmation());
  expect(await screen.findByText('Could not save keyboard progress')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
});
