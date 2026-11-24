import { render } from '@testing-library/react-native';
import { router, useFocusEffect } from 'expo-router';
import NotesListScreen from '../NotesListScreen';

let mockParams: Record<string, string> = {};
let mockFabActionPress: ((id: string) => void) | null = null;
const mockState = {
  folders: [],
  spaceFolders: [],
  folderCounts: {},
  notes: [],
  spaces: [],
  activeFolderId: null,
  activePrivateWorkspaceId: null as string | null,
  isInitialized: true,
  initialize: jest.fn(),
  setActiveFolderId: jest.fn(),
  setActiveSpaceId: jest.fn(),
  setActiveNoteId: jest.fn(),
  setSearchQuery: jest.fn(),
  searchQuery: '',
  createNote: jest.fn(),
  deleteNote: jest.fn(),
  createFolder: jest.fn(),
  renameFolder: jest.fn(),
  deleteFolderSafe: jest.fn(),
  voiceProfiles: [],
  loadVoiceProfiles: jest.fn(),
};

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), dismissTo: jest.fn() },
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => mockParams,
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
jest.mock('@/components/ui/Fab', () => ({
  FAB_BOTTOM_PADDING: 0,
  Fab: ({ onActionPress }: { onActionPress: (id: string) => void }) => {
    mockFabActionPress = onActionPress;
    return null;
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/notes/NotesTopBar', () => ({ NotesTopBar: () => null }));
jest.mock('@/components/notes/GroupedList', () => {
  const GroupedList = (): null => null;
  GroupedList.Row = (): null => null;
  return { GroupedList };
});
jest.mock('@/components/notes/FolderRow', () => ({ FolderRow: () => null }));
jest.mock('@/components/notes/NoteRow', () => ({ NoteRow: () => null }));
jest.mock('@/components/notes/SectionHeader', () => ({ SectionHeader: () => null }));
jest.mock('@/components/notes/MoveToFolderSheet', () => ({ MoveToFolderSheet: () => null }));
jest.mock('@/components/notes/NewFolderSheet', () => ({ NewFolderSheet: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));

const recordMeeting = (params: Record<string, string>): void => {
  mockParams = params;
  render(<NotesListScreen />);
  mockFabActionPress?.('meeting');
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFabActionPress = null;
  mockState.activePrivateWorkspaceId = null;
});

it.each(['folderId', 'spaceId'])(
  'returns to Folders when Account switches workspaces while browsing by %s',
  (param) => {
    mockParams = { [param]: '5' };
    render(<NotesListScreen />);
    const [focus] = jest.mocked(useFocusEffect).mock.calls[0];
    focus();
    expect(router.dismissTo).not.toHaveBeenCalled();
    jest.clearAllMocks();

    mockState.activePrivateWorkspaceId = 'team';
    focus();
    expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/(notes)');
    expect(mockState.setActiveFolderId).not.toHaveBeenCalled();
    expect(mockState.setActiveSpaceId).not.toHaveBeenCalled();
  },
);

describe('NotesListScreen Record meeting', () => {
  it('records into the folder being viewed', () => {
    recordMeeting({ folderId: '5' });
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/meeting-record',
      params: { folderId: '5' },
    });
  });

  it('records into the team space being viewed', () => {
    recordMeeting({ spaceId: '3' });
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/meeting-record',
      params: { spaceId: '3' },
    });
  });

  it("records into a space's folder rather than the space around it", () => {
    recordMeeting({ folderId: '9', spaceId: '3' });
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/meeting-record',
      params: { folderId: '9' },
    });
  });

  it('passes nothing when neither a folder nor a space is being viewed', () => {
    recordMeeting({});
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/meeting-record',
      params: {},
    });
  });
});
