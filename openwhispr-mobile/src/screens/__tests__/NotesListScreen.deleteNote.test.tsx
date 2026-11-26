import { Alert, Dimensions, type AlertButton, type AlertOptions } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import NotesListScreen from '../NotesListScreen';

// Shared values in creation order; each row's translateX is the first one it makes.
const mockSharedValues: { value: number }[] = [];
const mockDeleteNote = jest.fn();
const mockState = {
  folders: [],
  spaceFolders: [],
  folderCounts: {},
  notes: [
    {
      id: 7,
      title: 'Groceries',
      content: 'Milk and eggs',
      noteType: 'note',
      updatedAt: new Date().toISOString(),
    },
  ],
  spaces: [],
  activeFolderId: null,
  isInitialized: true,
  initialize: jest.fn(),
  setActiveFolderId: jest.fn(),
  setActiveSpaceId: jest.fn(),
  setActiveNoteId: jest.fn(),
  setSearchQuery: jest.fn(),
  searchQuery: '',
  createNote: jest.fn(),
  deleteNote: mockDeleteNote,
  createFolder: jest.fn(),
  renameFolder: jest.fn(),
  deleteFolderSafe: jest.fn(),
  voiceProfiles: [],
  loadVoiceProfiles: jest.fn(),
};

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/store/useNotesStore', () => {
  const useNotesStore = (selector?: (state: unknown) => unknown) =>
    selector ? selector(mockState) : mockState;
  useNotesStore.getState = () => mockState;
  return { useNotesStore };
});
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: {}, updateConfig: jest.fn() }),
}));
jest.mock('@/hooks/useMoveNote', () => ({
  useMoveNote: () => ({ open: jest.fn(), sheetProps: {} }),
}));
jest.mock('@/hooks/useManualSyncRefresh', () => ({
  useManualSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
}));
jest.mock('@/components/ui/Fab', () => ({ FAB_BOTTOM_PADDING: 0, Fab: () => null }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/notes/NotesTopBar', () => ({ NotesTopBar: () => null }));
jest.mock('@/components/notes/GroupedList', () => {
  const { View } = require('react-native');
  const GroupedList = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  GroupedList.Row = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return { GroupedList };
});
jest.mock('@/components/notes/FolderRow', () => ({ FolderRow: () => null }));
jest.mock('@/components/notes/SectionHeader', () => ({ SectionHeader: () => null }));
jest.mock('@/components/notes/MoveToFolderSheet', () => ({ MoveToFolderSheet: () => null }));
jest.mock('@/components/notes/NewFolderSheet', () => ({ NewFolderSheet: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000000', BRAND: '#000000' }));
jest.mock('lucide-react-native', () => ({
  Trash2: () => null,
  FolderInput: () => null,
  CloudOff: () => null,
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (initial: number) => {
      const sharedValue = { value: initial };
      mockSharedValues.push(sharedValue);
      return sharedValue;
    },
    useAnimatedStyle: () => ({}),
    // Animations land on their target at once, finishing callbacks included.
    withTiming: (
      target: number,
      _config: unknown,
      onFinish?: (finished: boolean) => void,
    ): number => {
      onFinish?.(true);
      return target;
    },
    runOnJS: <Args extends unknown[]>(fn: (...args: Args) => void) => fn,
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
    Easing: { cubic: 'cubic', quad: 'quad', out: () => 'out', in: () => 'in' },
  };
});
jest.mock('react-native-gesture-handler', () => {
  const gesture: Record<string, unknown> = {};
  for (const method of ['activeOffsetX', 'onUpdate', 'onEnd']) gesture[method] = () => gesture;
  return {
    Gesture: { Pan: () => gesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

type AlertCall = { buttons: AlertButton[]; options: AlertOptions | undefined };

const swipeToDelete = (): AlertCall => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<NotesListScreen />);
  fireEvent.press(screen.getByLabelText('Delete'));
  expect(alertSpy).toHaveBeenCalledTimes(1);
  const [, , buttons, options] = alertSpy.mock.calls[0];
  return { buttons: buttons ?? [], options };
};

const rowTranslateX = (): number => mockSharedValues[0].value;

beforeEach(() => {
  jest.clearAllMocks();
  mockSharedValues.length = 0;
});

describe('NotesListScreen swipe to delete', () => {
  it('has slid the row off screen while it waits for confirmation', () => {
    swipeToDelete();
    expect(rowTranslateX()).toBe(-Dimensions.get('window').width);
  });

  it('brings the note back when Cancel is pressed', () => {
    const { buttons } = swipeToDelete();

    buttons.find((button) => button.style === 'cancel')?.onPress?.();

    expect(rowTranslateX()).toBe(0);
    expect(mockDeleteNote).not.toHaveBeenCalled();
  });

  it('brings the note back when Android dismisses the dialog', () => {
    const { options } = swipeToDelete();

    options?.onDismiss?.();

    expect(rowTranslateX()).toBe(0);
    expect(mockDeleteNote).not.toHaveBeenCalled();
  });

  it('deletes the note when the delete is confirmed', () => {
    const { buttons } = swipeToDelete();

    buttons.find((button) => button.style === 'destructive')?.onPress?.();

    expect(mockDeleteNote).toHaveBeenCalledWith(7);
  });
});
