import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { router } from 'expo-router';
import type { GoogleCalendarEvent } from '@/data';
import type { AuthUser } from '@/lib/authClient';
import { useChatStore, type ChatSendResult } from '@/store/useChatStore';
import { ChatHomeScreen } from '../ChatHomeScreen';

const mockVoice = {
  state: 'idle' as 'idle' | 'listening' | 'transcribing',
  elapsedSeconds: 0,
  audioRecorder: {},
  start: jest.fn(async () => true),
  finish: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
};
let mockOnSent: ((conversationId: string) => void) | undefined;
let mockChatEnabled = true;
let mockUser: AuthUser | null = null;
let mockEvents: Partial<GoogleCalendarEvent>[] = [];

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = require('react');
    useEffect(effect, [effect]);
  },
}));
jest.mock('@/data', () => ({
  chatRepository: { listConversations: () => [] },
  calendarRepository: {},
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: AuthUser | null }) => unknown) =>
    selector({ user: mockUser }),
}));
jest.mock('@/lib/chat/runChatTurn', () => ({ runChatTurn: jest.fn() }));
jest.mock('@/lib/calendar/meetingSuggestions', () => ({
  getMeetingCalendarEventSuggestions: () => mockEvents,
}));
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: { getState: () => ({ accounts: [], load: async () => undefined }) },
}));
jest.mock('@/hooks/useChatSendGate', () => ({
  useChatSendGate: () => ({
    chatEnabled: mockChatEnabled,
    gate: (run: (allowCloudFallback: boolean) => void) => run(false),
  }),
}));
let mockTranscriptionAllowed = true;
const mockGateTranscription = jest.fn((run: () => void) => {
  if (mockTranscriptionAllowed) run();
});
jest.mock('@/hooks/useCloudTranscriptionGate', () => ({
  useCloudTranscriptionGate: () => mockGateTranscription,
}));
jest.mock('@/hooks/useChatVoiceInput', () => ({
  useChatVoiceInput: (options: { onSent?: (conversationId: string) => void }) => {
    mockOnSent = options.onSent;
    return mockVoice;
  },
}));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: () => ({ waveformData: [], currentAmplitude: 0 }),
}));
jest.mock('@/components/features/WaveformVisualizer', () => ({ RecordingBars: () => null }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (selector: (state: { activeMode: string }) => unknown) =>
    selector({ activeMode: 'cloud' }),
}));
jest.mock('@/components/ui/GlassIconButton', () => {
  const { Pressable } = require('react-native');
  return {
    GLASS_CAPSULE_SIZE: 36,
    GlassIconButton: ({
      accessibilityLabel,
      onPress,
    }: {
      accessibilityLabel: string;
      onPress: () => void;
    }) => <Pressable accessibilityLabel={accessibilityLabel} onPress={onPress} />,
  };
});
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockSend = jest.fn((): ChatSendResult | null => ({
  conversationId: 'c9',
  done: Promise.resolve(),
}));
const ACTION_ITEMS = 'What are my open action items from this week?';
const COMPOSER = 'Summarize my meetings this week';

const renderHome = async (): Promise<ReturnType<typeof render>> => {
  const screen = render(<ChatHomeScreen />);
  // Let the calendar load settle, which refreshes the suggestions.
  await act(async () => undefined);
  return screen;
};

beforeEach(() => {
  mockVoice.state = 'idle';
  mockOnSent = undefined;
  mockChatEnabled = true;
  mockEvents = [];
  mockTranscriptionAllowed = true;
  jest.clearAllMocks();
  useChatStore.setState({
    conversations: [],
    pending: null,
    failures: {},
    sendBlocked: false,
    send: mockSend,
  });
  mockUser = null;
});

describe('ChatHomeScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends a suggestion and opens its chat', async () => {
    const screen = await renderHome();
    fireEvent.press(screen.getByText(ACTION_ITEMS));
    expect(mockSend).toHaveBeenCalledWith(ACTION_ITEMS, {
      conversationId: null,
      allowCloudFallback: false,
    });
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/c9');
  });

  it('checks cloud transcription before opening the mic', async () => {
    const screen = await renderHome();

    mockTranscriptionAllowed = false;
    fireEvent.press(screen.getByLabelText('Speak your question'));
    expect(mockGateTranscription).toHaveBeenCalledTimes(1);
    expect(mockVoice.start).not.toHaveBeenCalled();

    mockTranscriptionAllowed = true;
    fireEvent.press(screen.getByLabelText('Speak your question'));
    expect(mockVoice.start).toHaveBeenCalledWith(false);
  });

  it('shows Chat turned off, keeping All chats', async () => {
    mockChatEnabled = false;
    const screen = await renderHome();

    expect(screen.getByText('Chat is turned off')).toBeTruthy();
    expect(screen.queryByPlaceholderText(COMPOSER)).toBeNull();
    expect(screen.getByLabelText('All chats')).toBeTruthy();

    fireEvent.press(screen.getByText('Open Chat settings'));
    expect(router.push).toHaveBeenCalledWith('/(account)/ai-workflow?scope=noteChat');
  });

  it('suggests a later meeting when the next one has been running a while', async () => {
    const now = new Date();
    const at = (hours: number, minutes = 0): string =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes).toISOString();
    jest.useFakeTimers({ now: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9) });
    const attendeesJson = JSON.stringify([
      { email: 'me@example.com', self: true },
      { email: 'sam@example.com' },
    ]);
    mockEvents = [
      { id: 1, summary: 'Standup', startAt: at(8, 30), endAt: at(9, 30), attendeesJson },
      { id: 2, summary: 'Design review', startAt: at(14), endAt: at(15), attendeesJson },
    ];
    const screen = await renderHome();

    fireEvent.press(screen.getByText('Prep me for Design review'));
    expect(screen.queryByText('Prep me for Standup')).toBeNull();
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringMatching(/^Prep me for "Design review" at /),
      {
        conversationId: null,
        allowCloudFallback: false,
      },
    );
  });

  it('greets a signed-in user by first name, and anyone else plainly', async () => {
    const guest = await renderHome();
    expect(guest.getByText('Ask anything')).toBeTruthy();
    guest.unmount();

    mockUser = {
      id: 'u',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      emailVerified: true,
      isAnonymous: false,
    };
    const signedIn = await renderHome();
    expect(signedIn.getByText('Hi Ada, ask anything')).toBeTruthy();
  });

  it('sends a typed question and opens its chat', async () => {
    const screen = await renderHome();
    fireEvent.changeText(screen.getByLabelText('Ask anything'), 'What changed?');
    fireEvent.press(screen.getByLabelText('Send'));

    expect(mockSend).toHaveBeenCalledWith('What changed?', {
      conversationId: null,
      allowCloudFallback: false,
    });
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/c9');
    expect(screen.getByPlaceholderText(COMPOSER).props.value).toBe('');
  });

  it('keeps the question and says so when a failed chat wipe refuses the send', async () => {
    mockSend.mockImplementationOnce(() => {
      useChatStore.setState({ sendBlocked: true });
      return null;
    });
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const screen = await renderHome();
    expect(screen.queryByText('Couldn’t send right now. Try again.')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Ask anything'), 'What changed?');
    fireEvent.press(screen.getByLabelText('Send'));

    expect(screen.getByText('Couldn’t send right now. Try again.')).toBeTruthy();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Couldn’t send right now. Try again.');
    expect(screen.getByPlaceholderText(COMPOSER).props.value).toBe('What changed?');
    expect(router.push).not.toHaveBeenCalled();
    announce.mockRestore();
  });

  it('ignores a suggestion tap while listening', async () => {
    mockVoice.state = 'listening';
    const screen = await renderHome();
    fireEvent.press(screen.getByText(ACTION_ITEMS));
    fireEvent.press(screen.getByLabelText('All chats'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('cancels listening when the screen loses focus', async () => {
    mockVoice.state = 'listening';
    const screen = await renderHome();
    expect(mockVoice.cancel).not.toHaveBeenCalled();

    screen.unmount();
    expect(mockVoice.cancel).toHaveBeenCalledTimes(1);
  });

  it('locks sending with no Stop while a chat is working, and links to it', async () => {
    const screen = await renderHome();
    act(() => {
      useChatStore.setState({
        conversations: [
          { id: 'c4', title: 'Pricing decisions', preview: '', createdAt: 1, updatedAt: 1 },
        ],
        pending: { conversationId: 'c4', phase: 'working', steps: [], startedAt: Date.now() },
      });
    });

    expect(screen.queryByLabelText('Stop')).toBeNull();
    expect(screen.getByPlaceholderText(COMPOSER).props.editable).toBe(true);
    fireEvent.press(screen.getByLabelText('Working on “Pricing decisions”…'));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/c4');
  });

  it('names a new chat’s question without a link', async () => {
    const screen = await renderHome();
    act(() => {
      useChatStore.setState({
        pending: { conversationId: null, phase: 'transcribing', steps: [], startedAt: Date.now() },
      });
    });

    expect(screen.getByText('Working on your question…')).toBeTruthy();
    expect(screen.queryByLabelText('Working on your question…')).toBeNull();
    expect(screen.queryByLabelText('Stop')).toBeNull();
    expect(screen.queryByText('Transcribing…')).toBeNull();
  });

  it('keeps Stop for its own spoken question while it transcribes', async () => {
    mockVoice.state = 'transcribing';
    const screen = await renderHome();
    act(() => {
      useChatStore.setState({
        pending: { conversationId: null, phase: 'transcribing', steps: [], startedAt: Date.now() },
      });
    });

    expect(screen.getByText('Transcribing…')).toBeTruthy();
    expect(screen.queryByText('Working on your question…')).toBeNull();
    fireEvent.press(screen.getByLabelText('Stop'));
    expect(mockVoice.cancel).toHaveBeenCalledTimes(1);
  });

  it('opens a spoken question’s chat only while Home has focus', async () => {
    const screen = await renderHome();
    mockOnSent?.('c1');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/c1');

    screen.unmount();
    mockOnSent?.('c2');
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
