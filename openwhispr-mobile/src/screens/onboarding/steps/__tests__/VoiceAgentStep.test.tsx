import { KeyboardAvoidingView } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { safeHaptics } from '@/lib/utils';
import { VoiceAgentStep } from '../VoiceAgentStep';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/utils', () => ({ ...jest.requireActual('@/lib/utils'), safeHaptics: jest.fn() }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useAnimatedStyle: () => ({}),
  // Stable across renders, as the real one is, so the pulse effect runs only when its inputs change.
  useSharedValue: (value: number) => require('react').useRef({ value }).current,
  withSequence: jest.fn(),
  withTiming: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
// Renders the symbol name so a test can tell which glyph an instruction shows.
jest.mock('@/components/ui/SystemIcon', () => {
  const { Text } = require('react-native');
  return { SystemIcon: ({ name }: { name: string }) => <Text>{`[${name}]`}</Text> };
});
let mockListener: (event: { status?: string; error?: string; updatedAtMs?: string }) => void;
jest.mock('../../../../../modules/app-group-storage/src', () => ({
  addKeyboardStatusChangedListener: (listener: typeof mockListener) => {
    mockListener = listener;
    return { remove: jest.fn() };
  },
}));
let mockDraft: string | null = null;
jest.mock('@/lib/keyboardAgentSync', () => ({ readKeyboardAgentDraft: () => mockDraft }));
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
let mockIsGuest = false;
let mockAccountHistory = false;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: mockUser, isGuest: mockIsGuest }),
}));
jest.mock('@/sync/syncIdentity', () => ({
  hasRealAccountHistory: () => mockAccountHistory,
}));

// The field is focused on arrival, and the glyph is the keyboard's own agent button.
const START = 'Tap the [wand.and.stars] button on your keyboard.';
const ASK = 'Say: “Write a message to my landlord asking if I can pay rent two days late.”';
// A first draft with nothing in brackets still gets a change to ask for.
const FOLLOW_UP =
  'Now tap Ask for changes and add a reason. Say: “Mention my paycheck comes in on Friday.”';
const DRAFT = 'Hi Maria, could I pay rent two days late this month? Thanks, Alex';
const INSERT = 'Tap ✓ to insert it.';
const DONE = 'That’s your voice assistant.';
const ACCOUNT_REQUIRED =
  'The live try isn’t available. Sign in at the end to use the voice assistant.';

const emit = (status: string, error?: string, updatedAtMs?: string): void => {
  act(() => mockListener({ status, error, updatedAtMs }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockSavedMode = 'cloud';
  mockUser = { id: 'anon' };
  mockIsGuest = false;
  mockAccountHistory = false;
  mockDraft = null;
  mockNext.mockResolvedValue(undefined);
  mockBack.mockResolvedValue(undefined);
});

it('starts by pointing to the agent button on the keyboard', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('Meet your voice assistant.')).toBeTruthy();
  expect(screen.getByText(START)).toBeTruthy();
  expect(screen.getByLabelText('Your message')).toBeTruthy();
  expect(screen.queryByText('Example request')).toBeNull();
});

it('says what the agent does in one line', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('Say what you need, and it writes it for you in any app.')).toBeTruthy();
});

// The keyboard is up for the whole try, so the buttons stay put and it covers them; Skip at the
// top is the way out until the draft is inserted and the keyboard closes.
it('lets the keyboard cover the buttons', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();
});

it('nudges with a haptic each time the instruction changes', () => {
  const screen = render(<VoiceAgentStep />);
  expect(safeHaptics).not.toHaveBeenCalled();
  emit('recording');
  expect(safeHaptics).toHaveBeenLastCalledWith('light');
  emit('agent_ready', undefined, '1000');
  emit('agent_ready', undefined, '2000');
  expect(safeHaptics).toHaveBeenCalledTimes(3);
  fireEvent.changeText(screen.getByLabelText('Your message'), DRAFT);
  expect(safeHaptics).toHaveBeenLastCalledWith('success');
});

it('addresses the practice message to the landlord', () => {
  const screen = render(<VoiceAgentStep />);
  expect(screen.getByText('To: Landlord')).toBeTruthy();
});

it('shows the request and a drafted message when the live try is unavailable', () => {
  mockUser = null;
  const screen = render(<VoiceAgentStep />);
  expect(
    screen.getByText('“Write a message to my landlord asking if I can pay rent two days late.”'),
  ).toBeTruthy();
  expect(screen.getByText(/^Hi, would it be okay .* Thanks for understanding\.$/)).toBeTruthy();
  // The example is a first draft: no follow-up and nothing asked for changes.
  expect(screen.queryByText(/Ask for changes|paycheck/)).toBeNull();
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
  fireEvent.changeText(screen.getByLabelText('Your message'), DRAFT);
  expect(screen.getByText(DONE)).toBeTruthy();
});

it('does not count ordinary dictation as trying the agent', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('ready');
  fireEvent.changeText(screen.getByLabelText('Your message'), 'Running late, can we push?');
  expect(screen.queryByText(DONE)).toBeNull();
  expect(screen.getByText(ASK)).toBeTruthy();
});

it('counts a draft once when the keyboard reports it twice', () => {
  // The native module emits each status directly and again from its own Darwin
  // notification; both copies carry the same updatedAtMs.
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  emit('agent_ready', undefined, '1000');
  expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
  emit('agent_ready', undefined, '2000');
  expect(screen.getByText(INSERT)).toBeTruthy();
});

it('keeps the first draft insertable when the refinement fails', () => {
  // The keyboard keeps the first draft on its card after a failed refinement.
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  emit('recording');
  emit('agent_error', 'Network request failed');
  expect(
    screen.getByText('The change didn’t go through. You can still insert this draft.'),
  ).toBeTruthy();
  expect(screen.getByText(INSERT)).toBeTruthy();
  expect(screen.getByText('Retry')).toBeTruthy();
  expect(screen.queryByText('Example request')).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Your message'), DRAFT);
  expect(screen.getByText(DONE)).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('keeps the draft insertable when the refinement needs an account', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  emit('agent_error', 'account_required');
  expect(screen.getByText(ACCOUNT_REQUIRED)).toBeTruthy();
  expect(screen.getByLabelText('Your message')).toBeTruthy();
  expect(screen.getByText(INSERT)).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('keeps the finished step when an agent error arrives after inserting the draft', () => {
  // Tapping regenerate again after inserting can hit a refused try.
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  fireEvent.changeText(screen.getByLabelText('Your message'), DRAFT);
  emit('agent_error', 'account_required');
  expect(screen.getByText(DONE)).toBeTruthy();
  expect(
    screen.getByDisplayValue('Hi Maria, could I pay rent two days late this month? Thanks, Alex'),
  ).toBeTruthy();
  expect(screen.queryByText(ACCOUNT_REQUIRED)).toBeNull();
  expect(screen.queryByText('Example request')).toBeNull();
});

it('clears a failed refinement once another draft arrives', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  emit('agent_error', 'Network request failed');
  emit('agent_ready', undefined, '2000');
  expect(screen.getByText(INSERT)).toBeTruthy();
  expect(
    screen.queryByText('The change didn’t go through. You can still insert this draft.'),
  ).toBeNull();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('does not offer a retry once the weekly word limit is reached', () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_error', 'usage_limit');
  expect(
    screen.getByText(
      'You’ve reached the weekly word limit. Try the voice assistant again once it resets.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('uses Cloud for the live try before a mode is chosen', () => {
  render(<VoiceAgentStep />);
  expect(mockSetMode).toHaveBeenCalledWith('cloud', true);
});

it('falls back to the example when the live try needs an account', () => {
  // Used-up tries, the word limit, or a server without the live try all look the same here, so the
  // note must not claim the user spent anything.
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_error', 'account_required');
  expect(screen.getByText(ACCOUNT_REQUIRED)).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.queryByText('Retry')).toBeNull();
});

it('offers a retry and the example when the agent fails before a draft', async () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_error', 'Network request failed');
  expect(
    screen.getByText('The voice assistant couldn’t finish. Try again or skip for now.'),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByText('Retry'));
  });
  expect(screen.getByText(START)).toBeTruthy();
  expect(screen.getByLabelText('Your message')).toBeTruthy();
});

it('starts the try over when retrying after a failed refinement', async () => {
  const screen = render(<VoiceAgentStep />);
  emit('recording');
  emit('agent_ready', undefined, '1000');
  emit('agent_error', 'Network request failed');
  await act(async () => {
    fireEvent.press(screen.getByText('Retry'));
  });
  expect(screen.getByText(START)).toBeTruthy();
  // A draft from before the retry no longer counts toward the follow-up.
  emit('agent_ready', undefined, '2000');
  expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
});

it.each([
  ['a Local choice', () => (mockMode = 'private')],
  ['a saved Local default', () => (mockSavedMode = 'private')],
])('shows the example instead of a live try for %s', (_label, arrange) => {
  arrange();
  const screen = render(<VoiceAgentStep />);
  expect(
    screen.getByText('The voice assistant uses Cloud. Here’s an example instead.'),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
  expect(screen.queryByText(START)).toBeNull();
  expect(mockSetMode).not.toHaveBeenCalled();
});

it('shows the example when there is no session to try the agent with', () => {
  mockUser = null;
  const screen = render(<VoiceAgentStep />);
  expect(
    screen.getByText('The voice assistant needs a connection. Here’s an example instead.'),
  ).toBeTruthy();
  expect(screen.getByText('Example request')).toBeTruthy();
});

it.each([
  ['a guest', () => (mockIsGuest = true)],
  ['a device that synced an account', () => (mockAccountHistory = true)],
])('says the voice assistant needs an account for %s', (_label, arrange) => {
  mockUser = null;
  arrange();
  const screen = render(<VoiceAgentStep />);
  expect(
    screen.getByText('The voice assistant needs an account. Here’s an example instead.'),
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
    fireEvent.press(screen.getByLabelText('Back'));
  });
  expect(mockBack).toHaveBeenCalledTimes(1);
});

// The step reads each draft and names the placeholders it still has.
describe('placeholders', () => {
  const FILL_IN =
    'Now tap Ask for changes and fill in [Landlord’s Name] and [Your Name]. Say: “My landlord is Maria, and sign it Alex.”';
  const STILL_MISSING =
    'Still missing [Your Name]. Tap Ask for changes again. Say: “Sign it Alex.” Or tap ✓ to insert it as is.';

  it('says what to fill in for the placeholders in the first draft', () => {
    const screen = render(<VoiceAgentStep />);
    emit('recording');
    mockDraft = 'Hi [Landlord’s Name], could I pay rent two days late? Thanks, [Your Name]';
    emit('agent_ready', undefined, '1000');
    expect(screen.getByText(FILL_IN)).toBeTruthy();
  });

  it('names what a changed draft still leaves in brackets, then offers insert once none are left', () => {
    const screen = render(<VoiceAgentStep />);
    emit('recording');
    mockDraft = 'Hi [Landlord’s Name], could I pay rent two days late? Thanks, [Your Name]';
    emit('agent_ready', undefined, '1000');
    mockDraft = 'Hi Maria, could I pay rent two days late? Thanks, [Your Name]';
    emit('agent_ready', undefined, '2000');
    expect(screen.getByText(STILL_MISSING)).toBeTruthy();
    jest.mocked(safeHaptics).mockClear();
    mockDraft = DRAFT;
    emit('agent_ready', undefined, '3000');
    expect(screen.getByText(INSERT)).toBeTruthy();
    // The phase stays the same, but the instruction changed.
    expect(safeHaptics).toHaveBeenCalledTimes(1);
  });

  it('keeps the general follow-up when the draft cannot be read', () => {
    const screen = render(<VoiceAgentStep />);
    emit('recording');
    emit('agent_ready', undefined, '1000');
    expect(screen.getByText(FOLLOW_UP)).toBeTruthy();
  });

  it('offers to insert the earlier draft when a change fails, placeholders or not', () => {
    const screen = render(<VoiceAgentStep />);
    emit('recording');
    mockDraft = 'Hi [Landlord’s Name], could I pay rent two days late?';
    emit('agent_ready', undefined, '1000');
    emit('agent_error', 'Network request failed');
    expect(screen.getByText(INSERT)).toBeTruthy();
  });

  it('does not nudge again for a draft that arrives after inserting', () => {
    const screen = render(<VoiceAgentStep />);
    emit('recording');
    emit('agent_ready', undefined, '1000');
    fireEvent.changeText(screen.getByLabelText('Your message'), DRAFT);
    jest.mocked(safeHaptics).mockClear();
    // Regenerating on the card after inserting.
    mockDraft = 'Hi [Landlord’s Name], could I pay rent two days late?';
    emit('agent_ready', undefined, '2000');
    expect(screen.getByText(DONE)).toBeTruthy();
    expect(safeHaptics).not.toHaveBeenCalled();
  });

  it('does not nudge when a new draft leaves the instruction the same', () => {
    render(<VoiceAgentStep />);
    emit('recording');
    mockDraft = '[Name], [Unit], [Amount], [Your Name]';
    emit('agent_ready', undefined, '1000');
    mockDraft = '[Name], [Unit], [Amount], [Due Date], [Your Name]';
    emit('agent_ready', undefined, '2000');
    jest.mocked(safeHaptics).mockClear();
    mockDraft = '[Name], [Unit], [Amount], [Your Name]';
    emit('agent_ready', undefined, '3000');
    expect(safeHaptics).not.toHaveBeenCalled();
  });
});
