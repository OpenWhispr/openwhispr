import { Keyboard, KeyboardAvoidingView } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DictationEmailStep } from '../DictationEmailStep';

jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
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
let mockSavedMode: 'private' | 'cloud' = 'cloud';
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (s: unknown) => unknown) =>
    selector({ config: { defaultMode: mockSavedMode } }),
}));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: (selector: (s: unknown) => unknown) => selector({ isTranscribing: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockSavedMode = 'cloud';
  mockUser = { id: 'anon' };
  mockNext.mockResolvedValue(undefined);
  mockEnsureSession.mockResolvedValue(undefined);
});

const SAMPLE_EMAIL =
  'Hey Tim, excited to chat. Are you free next Friday at 3pm… actually, 4pm? Thanks, Chad';

it('lays the practice out as an email to Tim with the sample as the placeholder', () => {
  const screen = render(<DictationEmailStep />);
  for (const text of ['To', 'Tim', 'Subject', 'Quick sync', 'Read this aloud']) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  expect(screen.getByLabelText('Your dictated email').props.placeholder).toBe(SAMPLE_EMAIL);
  expect(screen.getByText('works in any email app')).toBeTruthy();
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

it('offers retry after a recording failure, without an example', async () => {
  const screen = render(<DictationEmailStep />);
  act(() => mockListener({ status: 'error', error: 'Network unavailable' }));
  expect(screen.getByText('Network unavailable')).toBeTruthy();
  expect(screen.queryByText('Show an example')).toBeNull();
  expect(screen.queryByText(/Example/)).toBeNull();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledTimes(1));
});

it('keeps Local selected when revisiting practice', () => {
  mockMode = 'private';
  const screen = render(<DictationEmailStep />);
  expect(mockSetMode).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Your dictated email').props.editable).toBe(false);
  expect(screen.getByText('Practice uses Cloud. Skip it to keep Local.')).toBeTruthy();
  expect(screen.queryByText(/Example/)).toBeNull();
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

it('lets the user edit the inserted email without the keyboard closing on every keystroke', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const screen = render(<DictationEmailStep />);
  const field = screen.getByLabelText('Your dictated email');
  act(() => mockListener({ status: 'recording' }));
  act(() => mockListener({ status: 'ready' }));
  fireEvent.changeText(field, 'Hello Tim.');
  fireEvent.changeText(field, 'Hello Tim!');
  fireEvent.changeText(field, 'Hello Tim!!');
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismiss.mockRestore();
});

// After no speech the keyboard settles back to idle a couple of seconds later.
it('keeps the no-speech error until the next recording starts', () => {
  const screen = render(<DictationEmailStep />);
  act(() => mockListener({ status: 'no_speech' }));
  act(() => mockListener({ status: 'idle' }));
  expect(screen.getByText('No speech detected. Try again.')).toBeTruthy();
  act(() => mockListener({ status: 'recording' }));
  expect(screen.queryByText('No speech detected. Try again.')).toBeNull();
});

// Replaying onboarding starts with no choice made, but the saved Local default still stands.
it('keeps a saved Local default when replaying onboarding', () => {
  mockSavedMode = 'private';
  const screen = render(<DictationEmailStep />);
  expect(mockSetMode).not.toHaveBeenCalled();
  expect(screen.getByText('Practice uses Cloud. Skip it to keep Local.')).toBeTruthy();
});

it('explains why Cloud practice could not be retried', async () => {
  mockUser = null;
  const screen = render(<DictationEmailStep />);
  fireEvent.press(screen.getByText('Retry'));
  expect(
    await screen.findByText('Still no connection. Check it and try again, or skip for now.'),
  ).toBeTruthy();
});

it('lets the keyboard cover the buttons', () => {
  const screen = render(<DictationEmailStep />);
  expect(screen.UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();
});
