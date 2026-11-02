import { fireEvent, render } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import { useChatStore } from '@/store/useChatStore';
import { ChatHistoryScreen } from '../ChatHistoryScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: jest.fn(),
}));
jest.mock('@/data', () => ({ chatRepository: {} }));
jest.mock('@/lib/chat/runChatTurn', () => ({ runChatTurn: jest.fn() }));
const mockSwipeDeletes: ((restoreRow: () => void) => void)[] = [];
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({
    children,
    onDelete,
  }: {
    children: React.ReactNode;
    onDelete: (restoreRow: () => void) => void;
  }) => {
    mockSwipeDeletes.push(onDelete);
    return children;
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/GlassBackButton', () => ({ GlassBackButton: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockDeleteConversation = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockSwipeDeletes.length = 0;
  useChatStore.setState({
    conversations: [
      { id: 'c1', title: 'Pricing decisions', preview: 'We kept $12.', createdAt: 1, updatedAt: 1 },
    ],
    deleteConversation: mockDeleteConversation,
  });
});

describe('ChatHistoryScreen', () => {
  it('lets a screen reader delete a chat after confirming', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const screen = render(<ChatHistoryScreen />);
    const row = screen.getByText('Pricing decisions');

    expect(screen.getByRole('button').props.accessibilityActions).toEqual([
      { name: 'delete', label: 'Delete chat' },
    ]);
    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });

    // Nothing slid away, so there is nothing to restore and no cancel handler.
    expect(alert).toHaveBeenCalledWith('Delete this chat?', undefined, expect.any(Array));
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    buttons.find((button) => button.text === 'Delete')?.onPress?.();
    expect(mockDeleteConversation).toHaveBeenCalledWith('c1');
    alert.mockRestore();
  });

  it('slides a swiped row back when its delete is cancelled', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<ChatHistoryScreen />);
    const restoreRow = jest.fn();

    mockSwipeDeletes[mockSwipeDeletes.length - 1](restoreRow);
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    buttons.find((button) => button.text === 'Cancel')?.onPress?.();

    expect(restoreRow).toHaveBeenCalledTimes(1);
    expect(mockDeleteConversation).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
