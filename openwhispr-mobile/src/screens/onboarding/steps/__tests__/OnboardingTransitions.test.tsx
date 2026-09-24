import type React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  TextInput,
} from 'react-native';
import { NotificationsStep } from '../NotificationsStep';
import { KeyboardIntroStep } from '../KeyboardIntroStep';
import { MicrophoneStep } from '../MicrophoneStep';
import { GraduationStep } from '../GraduationStep';
import { KeyboardSwitchStep } from '../KeyboardSwitchStep';
import { GetStartedStep } from '../GetStartedStep';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
// The drag rule is covered by useSheetDragToDismiss's own test; the sheet only needs to render.
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: () => ({ dragGesture: {}, sheetStyle: {} }),
}));
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
const mockMicPermission = jest.fn();
const mockRequestMicPermission = jest.fn();
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({
    AudioModule: {
      getRecordingPermissionsAsync: () => mockMicPermission(),
      requestRecordingPermissionsAsync: () => mockRequestMicPermission(),
    },
  }),
}));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
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
  mockMicPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  mockRequestMicPermission.mockResolvedValue({ granted: true, canAskAgain: true });
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
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<NotificationsStep />);
  expect(await screen.findByText('Could not save progress.')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
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

it('explains a failed keyboard continuation without native error text', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockIsInstalled.mockReturnValue(true);
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  render(<KeyboardIntroStep />);
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not continue', 'Try again.'));
  alert.mockRestore();
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
  mockFinish.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<GraduationStep />);
  fireEvent.press(screen.getByLabelText('Messages'));
  expect(await screen.findByText('Could not finish setup. Try again.')).toBeTruthy();
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

it('allows a granted microphone step to retry a failed progress save', async () => {
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<MicrophoneStep />);
  expect(await screen.findByText('Could not save progress.')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
});

it('shows a retry if detected keyboard continuation cannot save progress', async () => {
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<KeyboardSwitchStep />);
  await act(async () => mockHeartbeatConfirmation());
  expect((await screen.findAllByText('Could not save progress.')).length).toBeGreaterThan(0);
  expect(screen.queryByText(/setValueWithKeyAsync/)).toBeNull();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
});

it('shows a retryable error when Get Started cannot save progress', async () => {
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<GetStartedStep />);
  fireEvent.press(screen.getByText('Get Started'));
  expect(await screen.findByText('Could not save your progress. Try again.')).toBeTruthy();
  fireEvent.press(screen.getByText('Get Started'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledTimes(2));
});

it('explains a failed continue from the blocked-microphone alert', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockMicPermission.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestMicPermission.mockResolvedValue({ granted: false, canAskAgain: false });
  mockNext.mockRejectedValueOnce(
    new Error("Calling the 'setValueWithKeyAsync' function has failed"),
  );
  const screen = render(<MicrophoneStep />);
  await screen.findByText('Allow microphone access');
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  const buttons = alert.mock.calls[0][2] ?? [];
  await act(async () => buttons.find((button) => button.text === 'Continue')?.onPress?.());
  expect(alert).toHaveBeenLastCalledWith('Could not continue', 'Could not save progress.');
});

it('lets the keyboard cover the switch step’s button, with help to get unstuck', () => {
  const screen = render(<KeyboardSwitchStep />);
  expect(screen.UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();

  // iOS keeps the keyboard above a modal, so help has to put it away first.
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  fireEvent.press(screen.getByLabelText('Help'));
  expect(dismiss).toHaveBeenCalled();
  expect(screen.getByText('Can’t switch to OpenWhispr?')).toBeTruthy();
  expect(screen.queryByText('Continue anyway')).toBeNull();
});

// iOS ignores a focus request while the sheet is still presented, so the keyboard comes back only
// once the sheet has fully gone.
it('brings the keyboard back after the help sheet has closed', async () => {
  jest.useFakeTimers();
  const screen = render(<KeyboardSwitchStep />);
  act(() => jest.advanceTimersByTime(200));
  const focus = jest.mocked(TextInput.prototype.focus);
  focus.mockClear();

  fireEvent.press(screen.getByLabelText('Help'));
  fireEvent.press(screen.getByText('Close'));
  expect(focus).not.toHaveBeenCalled();

  act(() => screen.UNSAFE_getByType(Modal).props.onDismiss());
  expect(focus).toHaveBeenCalledTimes(1);
});
