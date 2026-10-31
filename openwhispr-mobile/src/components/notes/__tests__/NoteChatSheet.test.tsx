import { Platform, TextInput } from 'react-native';
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

  it('steps aside once the user starts typing so a tap cannot discard the draft', () => {
    const { queryByLabelText } = renderSheet({ draft: 'Who owns the' });
    expect(queryByLabelText('List action items')).toBeNull();
  });

  it('ignores chip taps when there is nothing to ask about', () => {
    const { getByLabelText, props } = renderSheet({ canSend: false });
    fireEvent.press(getByLabelText('List action items'));
    expect(props.onSuggestion).not.toHaveBeenCalled();
  });
});
let mockLanguage = 'en';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: mockLanguage },
    t: (key: string, options: Record<string, unknown> = {}) => {
      const resources =
        mockLanguage === 'ar'
          ? require('@/locales/ar/translation.json').android
          : require('@/locales/en/translation.json').android;
      const value =
        key.split('.').reduce((node: any, part: string) => node?.[part], resources) ??
        options.defaultValue ??
        key;
      return String(value).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
    },
  }),
}));

it('preserves an Android draft through language changes and retains send/shortcut guards', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    const view = renderSheet({ draft: 'Literal draft', error: 'Literal provider error' });
    mockLanguage = 'ar';
    view.rerender(<NoteChatSheet {...view.props} />);
    expect(view.UNSAFE_getByType(TextInput).props.value).toBe('Literal draft');
    expect(view.getByText('Literal provider error')).toBeTruthy();
    expect(
      view.getByText('تستند الإجابات إلى هذه الملاحظة فقط. هذه المحادثة مؤقتة ولن تُحفظ.'),
    ).toBeTruthy();
    expect(view.queryByLabelText('سرد المهام')).toBeNull();
    fireEvent.press(view.getByLabelText('إرسال السؤال'));
    expect(view.props.onSend).toHaveBeenCalledTimes(1);
    view.rerender(<NoteChatSheet {...view.props} isProcessing />);
    fireEvent.press(view.getByLabelText('إرسال السؤال'));
    fireEvent.press(view.getByLabelText('إعادة محاولة السؤال'));
    expect(view.props.onSend).toHaveBeenCalledTimes(1);
    expect(view.props.onRetry).not.toHaveBeenCalled();
    view.rerender(<NoteChatSheet {...view.props} draft="" error={null} />);
    fireEvent.press(view.getByLabelText('سرد المهام'));
    expect(view.props.onSuggestion).toHaveBeenCalledWith(
      'What are the next steps from the meeting above that I need to do?',
    );
    view.rerender(<NoteChatSheet {...view.props} draft="" canSend={false} />);
    fireEvent.press(view.getByLabelText('سرد المهام'));
    expect(view.props.onSuggestion).toHaveBeenCalledTimes(1);
    Platform.OS = 'ios';
    view.rerender(<NoteChatSheet {...view.props} />);
    expect(view.getByLabelText('Send question')).toBeTruthy();
  } finally {
    Platform.OS = original;
    mockLanguage = 'en';
  }
});
