import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import type { ChatMessage } from '@/lib/chat/types';
import { safeHaptics } from '@/lib/utils';
import { ChatAssistantMessage } from '../ChatAssistantMessage';

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
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/notes/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    const { Text } = require('react-native');
    return <Text>{content}</Text>;
  },
}));

const message: ChatMessage = {
  id: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  text: 'You agreed on $40 per seat.',
  steps: [{ id: 'search', status: 'done', label: 'Searched your notes' }],
  sources: [{ noteId: 7, title: 'Pricing call' }],
  createdAt: 0,
};

describe('ChatAssistantMessage', () => {
  it('opens a source note', () => {
    const onOpenNote = jest.fn();
    const { getByText, getByRole } = render(
      <ChatAssistantMessage message={message} onOpenNote={onOpenNote} />,
    );
    expect(getByRole('link')).toBeTruthy();
    fireEvent.press(getByText('Pricing call'));
    expect(onOpenNote).toHaveBeenCalledWith(7);
  });

  it('copies the answer and says so briefly', async () => {
    jest.useFakeTimers();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { getByLabelText, queryByText } = render(
      <ChatAssistantMessage message={message} onOpenNote={jest.fn()} />,
    );
    expect(queryByText('Copied')).toBeNull();

    await act(async () => {
      fireEvent.press(getByLabelText('Copy answer'));
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('You agreed on $40 per seat.');
    expect(safeHaptics).toHaveBeenCalledWith('light');
    expect(queryByText('Copied')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Copied');

    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(queryByText('Copied')).toBeNull();
    jest.useRealTimers();
  });

  it('keeps "Copied" for its full time after a second copy', async () => {
    jest.useFakeTimers();
    const { getByLabelText, queryByText } = render(
      <ChatAssistantMessage message={message} onOpenNote={jest.fn()} />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText('Copy answer'));
    });
    act(() => {
      jest.advanceTimersByTime(1_500);
    });
    await act(async () => {
      fireEvent.press(getByLabelText('Copy answer'));
    });

    act(() => {
      jest.advanceTimersByTime(1_500);
    });
    expect(queryByText('Copied')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(queryByText('Copied')).toBeNull();
    jest.useRealTimers();
  });

  it('survives a failed clipboard write, claiming no copy', async () => {
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    const { getByLabelText, queryByText } = render(
      <ChatAssistantMessage message={message} onOpenNote={jest.fn()} />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText('Copy answer'));
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalled();
    expect(queryByText('Copied')).toBeNull();
  });

  it('offers Copy alone', () => {
    const { queryByLabelText } = render(
      <ChatAssistantMessage message={message} onOpenNote={jest.fn()} />,
    );
    expect(queryByLabelText('Share answer')).toBeNull();
  });
});
