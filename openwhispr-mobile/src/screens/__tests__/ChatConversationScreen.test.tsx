import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, Keyboard, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { chatRepository } from '@/data';
import { useChatStore } from '@/store/useChatStore';
import type { ChatConversation, ChatMessage, NewChatMessage } from '@/lib/chat/types';
import { ChatConversationScreen } from '../ChatConversationScreen';

let mockParams: Record<string, string> = { id: 'c1' };
// Off by default, so a test's seeded store state isn't reloaded from the repository.
let mockRunFocusEffects = false;
// Read on each render, so a rerender after changing it blurs or refocuses the screen.
let mockFocused = true;
const mockDb: { conversations: ChatConversation[]; messages: ChatMessage[] } = {
  conversations: [],
  messages: [],
};
let mockChatEnabled = true;
let mockVoiceOptions: {
  onSent?: (id: string) => void;
  onNotSent: (text: string) => void;
  isFocused: () => boolean;
} | null = null;
const mockVoice = {
  state: 'idle' as 'idle' | 'listening' | 'transcribing',
  elapsedSeconds: 3,
  audioRecorder: {},
  start: jest.fn(async () => true),
  finish: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), setParams: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = require('react');
    const focused = mockFocused;
    useEffect(() => (mockRunFocusEffects && focused ? effect() : undefined), [effect, focused]);
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/data', () => ({
  chatRepository: {
    listConversations: () =>
      mockDb.conversations.map((conversation) => ({ ...conversation, preview: '' })),
    getConversation: (id: string) =>
      mockDb.conversations.find((conversation) => conversation.id === id) ?? null,
    getMessages: (id: string) => mockDb.messages.filter((message) => message.conversationId === id),
    createConversation: jest.fn((title: string) => {
      const conversation = { id: 'c-new', title, createdAt: 1, updatedAt: 1 };
      mockDb.conversations.push(conversation);
      return conversation;
    }),
    appendMessage: jest.fn((input: NewChatMessage) => {
      const message = {
        id: `m${mockDb.messages.length + 1}`,
        steps: [],
        sources: [],
        createdAt: Date.now(),
        ...input,
      };
      mockDb.messages.push(message);
      return message;
    }),
  },
}));
jest.mock('@/lib/chat/runChatTurn', () => ({
  runChatTurn: jest.fn(async () => ({ text: 'Answer', steps: [], sources: [] })),
}));
jest.mock('@/hooks/useChatSendGate', () => ({
  useChatSendGate: () => ({
    chatEnabled: mockChatEnabled,
    gate: (run: (allowCloudFallback: boolean) => void) => run(false),
  }),
}));
jest.mock('@/hooks/useChatVoiceInput', () => ({
  useChatVoiceInput: (options: typeof mockVoiceOptions) => {
    mockVoiceOptions = options;
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
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { inOut: jest.fn(), ease: jest.fn(), linear: jest.fn() },
  cancelAnimation: jest.fn(),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: jest.fn(),
  withTiming: jest.fn(),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
jest.mock('@/components/ui/GlassBackButton', () => ({ GlassBackButton: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const question: ChatMessage = {
  id: 'm1',
  conversationId: 'c1',
  role: 'user',
  text: 'What did we decide?',
  steps: [],
  sources: [],
  createdAt: 1,
};

const realSend = useChatStore.getState().send;
const mockCancel = jest.fn();
const mockRetry = jest.fn(async () => undefined);
const mockEditFailedQuestion = jest.fn(() => 'What did we decide?');

beforeEach(() => {
  mockParams = { id: 'c1' };
  mockRunFocusEffects = false;
  mockFocused = true;
  mockChatEnabled = true;
  mockDb.conversations = [];
  mockDb.messages = [];
  mockVoice.state = 'idle';
  jest.clearAllMocks();
  useChatStore.setState({
    conversations: [
      { id: 'c1', title: 'Pricing decisions', preview: '', createdAt: 1, updatedAt: 1 },
    ],
    activeConversationId: 'c1',
    messages: [question],
    pending: null,
    failures: {},
    sendBlockedByWipe: false,
    send: realSend,
    cancel: mockCancel,
    retry: mockRetry,
    editFailedQuestion: mockEditFailedQuestion,
  });
});

describe('ChatConversationScreen', () => {
  it('shows the transcribing bubble for this chat', () => {
    useChatStore.setState({
      pending: { conversationId: 'c1', phase: 'transcribing', steps: [], startedAt: Date.now() },
    });
    const screen = render(<ChatConversationScreen />);
    expect(screen.getByText('Transcribing 0:03 of audio')).toBeTruthy();

    act(() => {
      useChatStore.setState({
        pending: { conversationId: 'c2', phase: 'transcribing', steps: [], startedAt: Date.now() },
      });
    });
    expect(screen.queryByText('Transcribing 0:03 of audio')).toBeNull();
  });

  it('shows the working line with a Stop button', () => {
    useChatStore.setState({
      pending: {
        conversationId: 'c1',
        phase: 'working',
        steps: [{ id: 'search', status: 'active', label: 'Searching your notes' }],
        startedAt: Date.now(),
      },
    });
    const screen = render(<ChatConversationScreen />);
    expect(screen.getByText('Searching your notes')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Stop'));
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('locks the composer with no Stop while another chat works, and links to it', () => {
    useChatStore.setState({
      conversations: [
        { id: 'c1', title: 'Pricing decisions', preview: '', createdAt: 1, updatedAt: 1 },
        { id: 'c2', title: 'Launch plan', preview: '', createdAt: 1, updatedAt: 1 },
      ],
      pending: { conversationId: 'c2', phase: 'working', steps: [], startedAt: Date.now() },
    });
    const screen = render(<ChatConversationScreen />);

    expect(screen.queryByLabelText('Stop')).toBeNull();
    expect(screen.getByPlaceholderText('Reply').props.editable).toBe(false);
    fireEvent.press(screen.getByLabelText('Working on “Launch plan”…'));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/c2');
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('shows Retry after a failure', () => {
    useChatStore.setState({
      failures: {
        c1: {
          conversationId: 'c1',
          messageId: 'm1',
          question: question.text,
          message: 'Check your connection and try again.',
        },
      },
    });
    const screen = render(<ChatConversationScreen />);
    expect(
      screen.getByText('Check your connection and try again. Your question is saved.'),
    ).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Retry'));
    expect(mockRetry).toHaveBeenCalledWith('c1', { allowCloudFallback: false });
  });

  it('fills the composer from Edit question', () => {
    useChatStore.setState({
      failures: {
        c1: {
          conversationId: 'c1',
          messageId: 'm1',
          question: question.text,
          message: 'Check your connection and try again.',
        },
      },
    });
    const screen = render(<ChatConversationScreen />);

    fireEvent.press(screen.getByLabelText('Edit question'));
    expect(mockEditFailedQuestion).toHaveBeenCalledWith('c1');
    expect(screen.getByPlaceholderText('Reply').props.value).toBe('What did we decide?');
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it('starts over as a new chat when Edit question empties this one', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    useChatStore.setState({
      failures: {
        c1: {
          conversationId: 'c1',
          messageId: 'm1',
          question: question.text,
          message: 'Check your connection and try again.',
        },
      },
    });
    mockEditFailedQuestion.mockImplementationOnce(() => {
      // The store deletes a conversation that editing leaves empty.
      useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] });
      return 'What did we decide?';
    });
    const screen = render(<ChatConversationScreen />);

    fireEvent.press(screen.getByLabelText('Edit question'));
    expect(router.setParams).toHaveBeenCalledWith({ id: 'new' });
    expect(screen.getByPlaceholderText('Reply').props.value).toBe('What did we decide?');
  });

  it('hides a failure from another chat', () => {
    useChatStore.setState({
      failures: {
        c2: { conversationId: 'c2', messageId: 'm9', question: 'Other', message: 'Offline' },
      },
    });
    const screen = render(<ChatConversationScreen />);
    expect(screen.queryByLabelText('Retry')).toBeNull();
  });

  it('ignores Retry and source taps while listening', () => {
    mockVoice.state = 'listening';
    useChatStore.setState({
      messages: [
        question,
        {
          ...question,
          id: 'm2',
          role: 'assistant',
          text: 'We kept $12.',
          sources: [{ noteId: 7, title: 'Pricing call' }],
        },
      ],
      failures: {
        c1: { conversationId: 'c1', messageId: 'm1', question: 'q', message: 'Offline' },
      },
    });
    const screen = render(<ChatConversationScreen />);

    fireEvent.press(screen.getByLabelText('Retry'));
    fireEvent.press(screen.getByText('Pricing call'));
    expect(mockRetry).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('disables Retry and Edit question while another chat is working', () => {
    useChatStore.setState({
      pending: { conversationId: 'c2', phase: 'working', steps: [], startedAt: Date.now() },
      failures: {
        c1: { conversationId: 'c1', messageId: 'm1', question: 'q', message: 'Offline' },
      },
    });
    const screen = render(<ChatConversationScreen />);

    expect(screen.getByLabelText('Retry').props.accessibilityState).toEqual({ disabled: true });
    fireEvent.press(screen.getByLabelText('Retry'));
    fireEvent.press(screen.getByLabelText('Edit question'));
    expect(mockRetry).not.toHaveBeenCalled();
    expect(mockEditFailedQuestion).not.toHaveBeenCalled();
  });

  it('says Chat is off above the composer and links to its setting', () => {
    mockChatEnabled = false;
    const screen = render(<ChatConversationScreen />);

    expect(screen.getByPlaceholderText('Reply').props.editable).toBe(false);
    fireEvent.press(screen.getByLabelText('Chat is turned off'));
    expect(router.push).toHaveBeenCalledWith('/(account)/ai-workflow?scope=noteChat');
  });

  it('opens a source note on the Chat tab’s own stack', () => {
    useChatStore.setState({
      messages: [
        question,
        {
          ...question,
          id: 'm2',
          role: 'assistant',
          text: 'We kept $12.',
          sources: [{ noteId: 7, title: 'Pricing call' }],
        },
      ],
    });
    const screen = render(<ChatConversationScreen />);

    fireEvent.press(screen.getByText('Pricing call'));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/(chat)/note/7');
  });

  it('keeps the reader’s place when content grows above the end', () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    const screen = render(<ChatConversationScreen />);
    const list = screen.UNSAFE_getByType(ScrollView);
    scrollToEnd.mockClear();

    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0 },
        layoutMeasurement: { height: 600 },
        contentSize: { height: 2_000 },
      },
    });
    fireEvent(list, 'contentSizeChange', 400, 2_200);
    expect(scrollToEnd).not.toHaveBeenCalled();

    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 1_560 },
        layoutMeasurement: { height: 600 },
        contentSize: { height: 2_200 },
      },
    });
    fireEvent(list, 'contentSizeChange', 400, 2_400);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockRestore();
  });

  it('announces the answer and an error to screen readers', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const working = {
      conversationId: 'c1',
      phase: 'working' as const,
      steps: [],
      startedAt: Date.now(),
    };
    useChatStore.setState({ pending: working });
    render(<ChatConversationScreen />);

    act(() => {
      useChatStore.setState({
        pending: null,
        messages: [question, { ...question, id: 'm2', role: 'assistant', text: 'We kept $12.' }],
      });
    });
    expect(announce).toHaveBeenCalledWith('Answer ready.');

    act(() => {
      useChatStore.setState({ pending: working });
    });
    act(() => {
      useChatStore.setState({
        pending: null,
        failures: {
          c1: { conversationId: 'c1', messageId: 'm1', question: 'q', message: 'Offline.' },
        },
      });
    });
    expect(announce).toHaveBeenLastCalledWith('Couldn’t get an answer. Offline.');
    expect(announce).toHaveBeenCalledTimes(2);
    announce.mockRestore();
  });

  it('announces nothing from a chat that is covered', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    useChatStore.setState({
      pending: { conversationId: 'c1', phase: 'working', steps: [], startedAt: Date.now() },
    });
    const screen = render(<ChatConversationScreen />);

    mockFocused = false;
    screen.rerender(<ChatConversationScreen />);
    act(() => {
      useChatStore.setState({
        pending: null,
        messages: [question, { ...question, id: 'm2', role: 'assistant', text: 'We kept $12.' }],
      });
    });

    expect(announce).not.toHaveBeenCalled();
    announce.mockRestore();
  });

  it('keeps its rows and place while another chat is pushed over it', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [
      { id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 },
      { id: 'c2', title: 'Launch plan', createdAt: 1, updatedAt: 1 },
    ];
    mockDb.messages = [question, { ...question, id: 'm9', conversationId: 'c2', text: 'Launch?' }];
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    const screen = render(<ChatConversationScreen />);
    const list = screen.UNSAFE_getByType(ScrollView);
    fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { y: 0 },
        layoutMeasurement: { height: 600 },
        contentSize: { height: 2_000 },
      },
    });

    // Chat B opens over this one, which stays mounted underneath.
    mockFocused = false;
    screen.rerender(<ChatConversationScreen />);
    act(() => {
      useChatStore.getState().openConversation('c2');
    });
    expect(screen.getByText(question.text)).toBeTruthy();
    expect(screen.queryByText('Launch?')).toBeNull();

    // Back from B: it closes, and this chat reloads the same rows without jumping to the end.
    act(() => {
      useChatStore.getState().closeConversation('c2');
    });
    mockFocused = true;
    screen.rerender(<ChatConversationScreen />);
    scrollToEnd.mockClear();
    fireEvent(list, 'contentSizeChange', 400, 2_000);
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeConversationId).toBe('c1');

    screen.unmount();
    expect(useChatStore.getState().activeConversationId).toBeNull();
    scrollToEnd.mockRestore();
  });

  it('drops its rows when its chat is wiped while another chat is open', () => {
    const screen = render(<ChatConversationScreen />);
    act(() => {
      useChatStore.setState({ activeConversationId: 'c2', messages: [] });
    });
    expect(screen.getByText(question.text)).toBeTruthy();

    act(() => {
      useChatStore.getState().reset();
    });

    expect(screen.queryByText(question.text)).toBeNull();
  });

  it('becomes a new chat when its chat goes while it is showing', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    const screen = render(<ChatConversationScreen />);
    expect(router.setParams).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().reset();
    });

    expect(screen.queryByText(question.text)).toBeNull();
    expect(router.setParams).toHaveBeenCalledWith({ id: 'new' });
  });

  it('becomes a new chat when it comes back to a chat that went while covered', () => {
    mockRunFocusEffects = true;
    mockFocused = false;
    const screen = render(<ChatConversationScreen />);

    mockFocused = true;
    screen.rerender(<ChatConversationScreen />);

    expect(router.setParams).toHaveBeenCalledWith({ id: 'new' });
  });

  it('jumps to the end of a chat as it opens, then animates later growth', () => {
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    const screen = render(<ChatConversationScreen />);
    const list = screen.UNSAFE_getByType(ScrollView);
    scrollToEnd.mockClear();

    fireEvent(list, 'contentSizeChange', 400, 2_000);
    fireEvent(list, 'contentSizeChange', 400, 2_200);

    expect(scrollToEnd.mock.calls).toEqual([[{ animated: false }], [{ animated: true }]]);
    scrollToEnd.mockRestore();
  });

  it('scrolls to the end for the keyboard only while showing', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    const listeners: (() => void)[] = [];
    const addListener = jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((event, listener) => {
        if (event === 'keyboardDidShow') listeners.push(listener as () => void);
        return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
      });
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    const screen = render(<ChatConversationScreen />);

    mockFocused = false;
    screen.rerender(<ChatConversationScreen />);
    scrollToEnd.mockClear();
    listeners.forEach((listener) => listener());
    expect(scrollToEnd).not.toHaveBeenCalled();

    mockFocused = true;
    screen.rerender(<ChatConversationScreen />);
    scrollToEnd.mockClear();
    listeners.forEach((listener) => listener());
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });

    addListener.mockRestore();
    scrollToEnd.mockRestore();
  });

  it('puts a spoken question back in the composer when the chat route changed', () => {
    const screen = render(<ChatConversationScreen />);

    act(() => {
      mockVoiceOptions?.onNotSent('When is my next meeting?');
    });
    expect(screen.getByPlaceholderText('Reply').props.value).toBe('When is my next meeting?');
  });

  it('adds a spoken question after what was already typed', () => {
    const screen = render(<ChatConversationScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Reply'), 'Also, ');

    act(() => {
      mockVoiceOptions?.onNotSent('when is my next meeting?');
    });
    expect(screen.getByPlaceholderText('Reply').props.value).toBe('Also, when is my next meeting?');
  });

  it('adopts a late spoken question only while it is still showing', () => {
    mockRunFocusEffects = true;
    mockParams = { id: 'new' };
    const screen = render(<ChatConversationScreen />);
    expect(mockVoiceOptions?.isFocused()).toBe(true);

    act(() => {
      mockVoiceOptions?.onSent?.('c7');
    });
    expect(router.setParams).toHaveBeenCalledWith({ id: 'c7' });

    const options = mockVoiceOptions;
    screen.unmount();
    expect(options?.isFocused()).toBe(false);
    options?.onSent?.('c8');
    expect(router.setParams).toHaveBeenCalledTimes(1);
  });

  it('cancels listening when the screen loses focus', () => {
    mockRunFocusEffects = true;
    mockVoice.state = 'listening';
    const screen = render(<ChatConversationScreen />);
    expect(mockVoice.cancel).not.toHaveBeenCalled();

    screen.unmount();
    expect(mockVoice.cancel).toHaveBeenCalledTimes(1);
  });

  it('adopts the new id after the first send on a new chat', async () => {
    mockRunFocusEffects = true;
    mockParams = { id: 'new' };
    const screen = render(<ChatConversationScreen />);

    // Nothing to reply to yet.
    expect(screen.queryByPlaceholderText('Reply')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText('Ask anything'), 'First question');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Send'));
    });
    expect(router.setParams).toHaveBeenCalledWith({ id: 'c-new' });

    mockParams = { id: 'c-new' };
    screen.rerender(<ChatConversationScreen />);
    // The question titles the new chat and shows as its first message.
    expect(screen.getAllByText('First question')).toHaveLength(2);
    expect(screen.getByText('Answer')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('Reply'), 'Second question');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Send'));
    });
    expect(chatRepository.createConversation).toHaveBeenCalledTimes(1);
    expect(chatRepository.appendMessage).toHaveBeenCalledWith({
      conversationId: 'c-new',
      role: 'user',
      text: 'Second question',
    });
    expect(router.setParams).toHaveBeenCalledTimes(1);
  });

  it('keeps the reply and says so when a failed chat wipe refuses the send', () => {
    useChatStore.setState({
      send: jest.fn(() => {
        useChatStore.setState({ sendBlockedByWipe: true });
        return null;
      }),
    });
    const screen = render(<ChatConversationScreen />);

    fireEvent.changeText(screen.getByPlaceholderText('Reply'), 'And the price?');
    fireEvent.press(screen.getByLabelText('Send'));

    expect(screen.getByText('Couldn’t send right now. Try again.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Reply').props.value).toBe('And the price?');
  });

  it('reads out a refusal by a failed chat wipe, only from the chat on screen', () => {
    mockRunFocusEffects = true;
    mockDb.conversations = [{ id: 'c1', title: 'Pricing decisions', createdAt: 1, updatedAt: 1 }];
    mockDb.messages = [question];
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const screen = render(<ChatConversationScreen />);

    act(() => {
      useChatStore.setState({ sendBlockedByWipe: true });
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Couldn’t send right now. Try again.');

    act(() => {
      useChatStore.setState({ sendBlockedByWipe: false });
    });
    mockFocused = false;
    screen.rerender(<ChatConversationScreen />);
    act(() => {
      useChatStore.setState({ sendBlockedByWipe: true });
    });
    expect(announce).toHaveBeenCalledTimes(1);
    announce.mockRestore();
  });
});
