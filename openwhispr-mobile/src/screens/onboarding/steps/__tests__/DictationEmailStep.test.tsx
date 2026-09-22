import { Keyboard } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DictationEmailStep } from '../DictationEmailStep';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
let mockListener: (event: { status?: string; error?: string }) => void;
jest.mock('../../../../../modules/app-group-storage/src', () => ({
  addKeyboardStatusChangedListener: (listener: typeof mockListener) => {
    mockListener = listener;
    return { remove: jest.fn() };
  },
}));
const mockNext = jest.fn();
let mockMode: 'private' | 'cloud' | null = null;
const mockSetMode = jest.fn();
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: unknown) => unknown) =>
    selector({ goNext: mockNext, selectedMode: mockMode }),
  getStepProgress: () => ({ current: 4, total: 8 }),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: 'private', isUserOverride: false, setActiveMode: mockSetMode }),
  },
}));
let mockUser: { id: string } | null = { id: 'anon' };
const mockEnsureSession = jest.fn();
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ user: mockUser, ensureAnonymousSession: mockEnsureSession }),
    { getState: () => ({ user: mockUser }) },
  ),
}));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: (selector: (s: unknown) => unknown) => selector({ isTranscribing: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockUser = { id: 'anon' };
  mockNext.mockResolvedValue(undefined);
  mockEnsureSession.mockResolvedValue(undefined);
});

it('shows recording and processing state, then displays the inserted result', async () => {
  const screen = render(<DictationEmailStep />);
  act(() => mockListener({ status: 'recording' }));
  expect(screen.getByText('Listening…')).toBeTruthy();
  act(() => mockListener({ status: 'transcribing' }));
  expect(screen.getByText('Transcribing…')).toBeTruthy();
  act(() => mockListener({ status: 'ready' }));
  fireEvent.changeText(screen.getByLabelText('Your dictated email'), 'Hello Tim, see you at four.');
  expect(screen.getByText('Your email is ready')).toBeTruthy();
});

it('offers a labeled sample and retry after a recording failure', async () => {
  const screen = render(<DictationEmailStep />);
  act(() => mockListener({ status: 'error', error: 'Network unavailable' }));
  expect(screen.getByText('Network unavailable')).toBeTruthy();
  fireEvent.press(screen.getByText('Show an example'));
  expect(screen.getByText('Example · not a live transcription')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledTimes(1));
});

it('keeps Local selected when revisiting practice', () => {
  mockMode = 'private';
  const screen = render(<DictationEmailStep />);
  expect(mockSetMode).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Your dictated email').props.editable).toBe(false);
  expect(screen.getByText('Example · not a live transcription')).toBeTruthy();
});

it('keeps offline practice skippable', async () => {
  mockUser = null;
  const screen = render(<DictationEmailStep />);
  fireEvent.press(screen.getByText('Skip'));
  await waitFor(() => expect(mockNext).toHaveBeenCalledWith('dictation-email'));
});

it('does not dismiss the keyboard until the pending transcript has actually been inserted', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const screen = render(<DictationEmailStep />);
  act(() => mockListener({ status: 'recording' }));
  act(() => mockListener({ status: 'ready' }));
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Your dictated email'), 'Hello Tim.');
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismiss.mockRestore();
});
