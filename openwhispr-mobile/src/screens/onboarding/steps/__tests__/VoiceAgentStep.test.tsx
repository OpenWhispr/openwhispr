import { act, fireEvent, render } from '@testing-library/react-native';
import { VoiceAgentStep } from '../VoiceAgentStep';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
let mockListener: (event: { status?: string; error?: string }) => void;
jest.mock('../../../../../modules/app-group-storage/src', () => ({
  addKeyboardStatusChangedListener: (listener: typeof mockListener) => {
    mockListener = listener;
    return { remove: jest.fn() };
  },
}));
const mockNext = jest.fn();
const mockBack = jest.fn();
jest.mock('@/hooks/useOnboardingStep', () => ({
  useOnboardingStep: () => ({
    goNext: mockNext,
    goBack: mockBack,
    progress: { current: 5, total: 9 },
  }),
}));
let mockMode: 'private' | 'cloud' | null = null;
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: (selector: (s: unknown) => unknown) => selector({ selectedMode: mockMode }),
}));
const mockSetMode = jest.fn();
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: 'private', isUserOverride: false, setActiveMode: mockSetMode }),
  },
}));
let mockSavedMode: 'private' | 'cloud' = 'cloud';
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (s: unknown) => unknown) =>
    selector({ config: { defaultMode: mockSavedMode } }),
}));
let mockUser: { id: string } | null = { id: 'anon' };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: mockUser }),
}));

const START = 'Tap the field, then the ✨ agent button on your keyboard.';
const ASK = 'Say: “Write a message inviting Sam to lunch tomorrow at noon.”';
const FOLLOW_UP = 'Now tap Ask for changes and say: “Make this more concise.”';
const INSERT = 'Tap ✓ to insert it.';
const DONE = 'That’s your voice agent.';

const emit = (status: string, error?: string): void => {
  act(() => mockListener({ status, error }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockSavedMode = 'cloud';
  mockUser = { id: 'anon' };
  mockNext.mockResolvedValue(undefined);
  mockBack.mockResolvedValue(undefined);
});

it('starts by pointing to the agent button on the keyboard', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('Meet your voice agent.')).toBeTruthy();
  expect(screen.getByText(START)).toBeTruthy();
  expect(screen.getByLabelText('Your message')).toBeTruthy();
  expect(screen.queryByText('Example request')).toBeNull();
});

it('walks through a request, a spoken follow-up and inserting the result', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  expect(screen.getByText(ASK)).toBeTruthy();
  emit('agent_generating');
  emit('agent_ready');
  expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
  // Recording the follow-up keeps the follow-up instruction on screen.
  emit('recording');
  expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
  emit('agent_ready');
  expect(screen.getByText(INSERT)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Your message'), 'Hey Sam, lunch tomorrow at noon?');
  expect(screen.getByText(DONE)).toBeTruthy();
});

it('does not count ordinary dictation as trying the agent', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('ready');
  fireEvent.changeText(screen.getByLabelText('Your message'), 'Hey Sam, lunch tomorrow?');
  expect(screen.queryByText(DONE)).toBeNull();
  expect(screen.getByText(ASK)).toBeTruthy();
});

it('uses Cloud for the live try before a mode is chosen', () => {
  render(<VoiceAgentStep />);
  expect(mockSetMode).toHaveBeenCalledWith('cloud', true);
});

it('falls back to the example once the free tries are used up', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_error', 'account_required');
  expect(
    screen.getByText('You’ve used the free tries. Sign in at the end to keep using the agent.'),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('offers a retry and the example after another agent error', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready');
  emit('agent_error', 'Network request failed');
  expect(screen.getByText('The agent couldn’t finish. Try again or skip for now.')).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  expect(screen.getByText(START)).toBeTruthy();
  // A draft from before the error no longer counts toward the follow-up.
  emit('agent_ready');
  expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
});

it.each([
  ['a Local choice', () => (mockMode = 'private')],
  ['a saved Local default', () => (mockSavedMode = 'private')],
])('shows the example instead of a live try for %s', (_label, arrange) => {
  arrange();
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('The voice agent uses Cloud. Here’s an example instead.')).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.queryByText(START)).toBeNull();
  expect(mockSetMode).not.toHaveBeenCalled();
});

it('shows the example when there is no session to try the agent with', () => {
  mockUser = null;
  const screen = render(<VoiceAgentStep />);
  expect(
    screen.getByText('The voice agent needs a connection. Here’s an example instead.'),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
});

it.each(['Continue', 'Skip'])('leaves the voice-agent step using %s', async (action) => {
  const screen = render(<VoiceAgentStep />);
  await act(async () => {
    fireEvent.press(screen.getByText(action));
  });
  expect(mockNext).toHaveBeenCalledTimes(1);
});

it('can return to dictation practice', async () => {
  const screen = render(<VoiceAgentStep />);
  await act(async () => {
    fireEvent.press(screen.getByText('Back'));
  });
  expect(mockBack).toHaveBeenCalledTimes(1);
});
