import { fireEvent, render } from '@testing-library/react-native';
import { NoteChatSheet } from '../NoteChatSheet';
import { getNoteChatSuggestions } from '@/lib/notes/noteChatSuggestions';
import type { ChatOverNoteMessage } from '@/lib/notes/chatOverNote';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({ GlassIconButton: () => null }));
jest.mock('@/components/notes/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => {
    const { Text } = require('react-native');
    return <Text>{content}</Text>;
  },
}));

const meetingSuggestions = getNoteChatSuggestions(true);

const renderSheet = (overrides: Partial<React.ComponentProps<typeof NoteChatSheet>> = {}) => {
  const props: React.ComponentProps<typeof NoteChatSheet> = {
    visible: true,
    messages: [],
    draft: '',
    isProcessing: false,
    error: null,
    canSend: true,
    suggestions: meetingSuggestions,
    onDraftChange: jest.fn(),
    onSend: jest.fn(),
    onSuggestion: jest.fn(),
    onRetry: jest.fn(),
    onClear: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  return { ...render(<NoteChatSheet {...props} />), props };
};

describe('NoteChatSheet suggestions', () => {
  it('offers the meeting shortcuts in order before the first message', () => {
    const { getAllByRole } = renderSheet();
    const labels = getAllByRole('button')
      .map((button) => button.props.accessibilityLabel)
      .filter((label) => meetingSuggestions.some((suggestion) => suggestion.label === label));
    expect(labels).toEqual([
      'List action items',
      'Write follow-up email',
      'Key decisions',
      'List Q&A',
    ]);
  });

  it('sends the full prompt, not the chip label, when a chip is tapped', () => {
    const { getByLabelText, props } = renderSheet();
    fireEvent.press(getByLabelText('List action items'));
    expect(props.onSuggestion).toHaveBeenCalledWith(
      'What are the next steps from the meeting above that I need to do?',
    );
  });

  it('drops the shortcuts once the conversation has started', () => {
    const messages: ChatOverNoteMessage[] = [
      { id: '1', role: 'user', text: 'Who owns the launch?', createdAt: 0 },
    ];
    const { queryByLabelText } = renderSheet({ messages });
    expect(queryByLabelText('List action items')).toBeNull();
  });

  it('ignores chip taps while a question is in flight', () => {
    const { getByLabelText, props } = renderSheet({ isProcessing: true });
    fireEvent.press(getByLabelText('List action items'));
    expect(props.onSuggestion).not.toHaveBeenCalled();
  });
});
