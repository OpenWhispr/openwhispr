import { act, render } from '@testing-library/react-native';
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { supportsVoiceEnrollment } from '@/lib/voiceEnrollmentCapability';
import FoldersScreen from '../FoldersScreen';
import NotesListScreen from '../NotesListScreen';

let mockParams: { folderId?: string; spaceId?: string } = {};
let mockFab: { onActionPress: (id: string) => void };
const mockSheets: { visible: boolean }[] = [];
const mockState = {
  folders: [],
  spaceFolders: [],
  folderCounts: {},
  notes: [],
  spaces: [],
  voiceProfiles: [],
  activeFolderId: null as number | null,
  activeSpaceId: null as number | null,
  isInitialized: true,
  searchQuery: '',
  initialize: jest.fn(),
  loadVoiceProfiles: jest.fn(),
  setActiveFolderId: jest.fn(),
  setActiveSpaceId: jest.fn(),
  setActiveNoteId: jest.fn(),
  setSearchQuery: jest.fn(),
  createNote: jest.fn(),
  deleteNote: jest.fn(),
  createFolder: jest.fn(),
  renameFolder: jest.fn(),
  deleteFolderSafe: jest.fn(),
};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), setParams: jest.fn() },
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-i18next', () => ({
  useTranslation: jest.fn(() => ({ t: (key: string) => key })),
}));
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: jest.fn(() => ({
    copy: (_key: string, fallback: string) => fallback,
    language: 'en',
  })),
}));
jest.mock('@/android/ui', () => ({ AccountButton: () => null }));
jest.mock('@/data', () => ({ notesRepository: { searchNotes: jest.fn(() => []) } }));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: Object.assign(() => mockState, { getState: () => mockState }),
}));
jest.mock('@/hooks/useMoveNote', () => ({
  useMoveNote: () => ({ open: jest.fn(), sheetProps: {} }),
}));
jest.mock('@/hooks/useManualSyncRefresh', () => ({
  useManualSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
}));
jest.mock('@/hooks/useNoteBuckets', () => ({ useNoteBuckets: () => [] }));
jest.mock('@/lib/voiceEnrollmentCapability', () => ({
  supportsVoiceEnrollment: jest.fn(() => true),
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/Fab', () => ({
  FAB_BOTTOM_PADDING: 0,
  Fab: (props: typeof mockFab) => {
    mockFab = props;
    return null;
  },
}));
jest.mock('@/components/notes/NotesTopBar', () => ({ NotesTopBar: () => null }));
jest.mock('@/components/notes/GroupedList', () => ({
  GroupedList: Object.assign(() => null, { Row: () => null }),
}));
jest.mock('@/components/notes/FolderRow', () => ({ FolderRow: () => null }));
jest.mock('@/components/notes/NoteRow', () => ({ NoteRow: () => null }));
jest.mock('@/components/notes/SectionHeader', () => ({ SectionHeader: () => null }));
jest.mock('@/components/notes/SpacesSection', () => ({ SpacesSection: () => null }));
jest.mock('@/components/notes/MoveToFolderSheet', () => ({ MoveToFolderSheet: () => null }));
jest.mock('@/components/notes/NewFolderSheet', () => ({
  NewFolderSheet: (props: { visible: boolean }) => {
    mockSheets.push(props);
    return null;
  },
}));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSheets.length = 0;
  mockParams = {};
  mockState.activeFolderId = null;
  mockState.activeSpaceId = null;
  mockState.isInitialized = true;
  mockState.searchQuery = '';
  mockState.setActiveFolderId.mockImplementation((id: number | null) => {
    mockState.activeFolderId = id;
    mockState.activeSpaceId = null;
    mockState.searchQuery = '';
  });
  mockState.setActiveSpaceId.mockImplementation((id: number | null) => {
    mockState.activeSpaceId = id;
    mockState.activeFolderId = null;
    mockState.searchQuery = '';
  });
});

describe('upstream iOS library screen boundary', () => {
  it('mounts only the creation sheet in Folders without Android localization', () => {
    render(<FoldersScreen />);
    expect(mockSheets).toHaveLength(1);
    expect(useTranslation).not.toHaveBeenCalled();
    expect(useAndroidCopy).not.toHaveBeenCalled();
  });
  it('mounts only the creation sheet in Notes without Android localization', () => {
    render(<NotesListScreen />);
    expect(mockSheets).toHaveLength(1);
    expect(useTranslation).not.toHaveBeenCalled();
    expect(useAndroidCopy).not.toHaveBeenCalled();
  });
  it.each(['folder', 'space'] as const)(
    'preserves search when refocusing the selected %s',
    (scope) => {
      if (scope === 'folder') {
        mockParams = { folderId: '2' };
        mockState.activeFolderId = 2;
      } else {
        mockParams = { spaceId: '3' };
        mockState.activeSpaceId = 3;
      }
      render(<NotesListScreen />);
      const focus = jest.mocked(useFocusEffect).mock.calls.at(-1)?.[0];
      mockState.searchQuery = 'Keep this search';
      act(() => {
        focus?.();
        focus?.();
      });
      expect(mockState.searchQuery).toBe('Keep this search');
      expect(mockState.setActiveFolderId).not.toHaveBeenCalled();
      expect(mockState.setActiveSpaceId).not.toHaveBeenCalled();
    },
  );
  it('selects a different folder before initialization as upstream did', () => {
    mockParams = { folderId: '2' };
    mockState.activeFolderId = 1;
    mockState.isInitialized = false;
    render(<NotesListScreen />);
    act(() => {
      jest.mocked(useFocusEffect).mock.calls.at(-1)?.[0]();
    });
    expect(mockState.setActiveFolderId).toHaveBeenCalledWith(2);
    expect(router.setParams).not.toHaveBeenCalled();
  });
  it('ignores an import action absent from the iOS menu', () => {
    render(<NotesListScreen />);
    act(() => mockFab.onActionPress('import'));
    expect(router.push).not.toHaveBeenCalled();
  });
  it('keeps the original voice entry without the Android capability probe', () => {
    render(<NotesListScreen />);
    expect(supportsVoiceEnrollment).not.toHaveBeenCalled();
  });
});
