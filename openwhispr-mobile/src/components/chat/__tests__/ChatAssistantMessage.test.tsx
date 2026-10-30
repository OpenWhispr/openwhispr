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

const NONE_MISSING: ReadonlySet<number> = new Set();

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
      <ChatAssistantMessage
        message={message}
        onOpenNote={onOpenNote}
        missingNoteIds={NONE_MISSING}
      />,
    );
    expect(getByRole('link')).toBeTruthy();
    fireEvent.press(getByText('Pricing call'));
    expect(onOpenNote).toHaveBeenCalledWith(7);
  });

  it('shows only the notes the answer named, and counts only them', () => {
    const read: ChatMessage = {
      ...message,
      sources: [
        { noteId: 7, title: 'Pricing call', cited: true },
        { noteId: 8, title: 'Roadmap', cited: false },
      ],
    };
    const { queryByText, getByText } = render(
      <ChatAssistantMessage message={read} onOpenNote={jest.fn()} missingNoteIds={NONE_MISSING} />,
    );
    expect(getByText('Pricing call')).toBeTruthy();
    expect(queryByText('Roadmap')).toBeNull();
    expect(getByText('Searched your notes · 1 source')).toBeTruthy();
  });

  it('shows no source when the answer named none of the notes it read, and says they were read', () => {
    const read: ChatMessage = {
      ...message,
      sources: [{ noteId: 8, title: 'Roadmap', cited: false }],
    };
    const { queryByRole, getByText } = render(
      <ChatAssistantMessage message={read} onOpenNote={jest.fn()} missingNoteIds={NONE_MISSING} />,
    );
    expect(queryByRole('link')).toBeNull();
    expect(getByText('Searched your notes · 1 read')).toBeTruthy();
  });

  it('says no notes matched only when none were read, and claims nothing when that is unknown', () => {
    const none: ChatMessage = { ...message, sources: [] };
    expect(
      render(
        <ChatAssistantMessage
          message={none}
          onOpenNote={jest.fn()}
          missingNoteIds={NONE_MISSING}
        />,
      ).getByText('Searched your notes · no matches'),
    ).toBeTruthy();
    expect(
      render(
        <ChatAssistantMessage
          message={{ ...none, sourcesUnreadable: true }}
          onOpenNote={jest.fn()}
          missingNoteIds={NONE_MISSING}
        />,
      ).getByText('Searched your notes'),
    ).toBeTruthy();
  });

  it('disables the chip of a deleted note and keeps the others', () => {
    const onOpenNote = jest.fn();
    const twoSources: ChatMessage = {
      ...message,
      sources: [...message.sources, { noteId: 8, title: 'Roadmap' }],
    };
    const { getByLabelText } = render(
      <ChatAssistantMessage
        message={twoSources}
        onOpenNote={onOpenNote}
        missingNoteIds={new Set([7])}
      />,
    );

    const deleted = getByLabelText('Pricing call, deleted');
    expect(deleted.props.accessibilityState).toEqual({ disabled: true });
    fireEvent.press(deleted);
    expect(onOpenNote).not.toHaveBeenCalled();
    fireEvent.press(getByLabelText('Roadmap'));
    expect(onOpenNote).toHaveBeenCalledWith(8);
  });

  it('copies the answer and says so briefly', async () => {
    jest.useFakeTimers();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { getByLabelText, queryByText } = render(
      <ChatAssistantMessage
        message={message}
        onOpenNote={jest.fn()}
        missingNoteIds={NONE_MISSING}
      />,
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
      <ChatAssistantMessage
        message={message}
        onOpenNote={jest.fn()}
        missingNoteIds={NONE_MISSING}
      />,
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
      <ChatAssistantMessage
        message={message}
        onOpenNote={jest.fn()}
        missingNoteIds={NONE_MISSING}
      />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText('Copy answer'));
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalled();
    expect(queryByText('Copied')).toBeNull();
  });

  it('offers Copy alone', () => {
    const { queryByLabelText } = render(
      <ChatAssistantMessage
        message={message}
        onOpenNote={jest.fn()}
        missingNoteIds={NONE_MISSING}
      />,
    );
    expect(queryByLabelText('Share answer')).toBeNull();
  });
});
