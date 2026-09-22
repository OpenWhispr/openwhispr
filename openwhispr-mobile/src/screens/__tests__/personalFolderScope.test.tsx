// Fix round 2, Finding 3: every personal folder surface — the FoldersScreen
// browsing list (which is also the rename/delete surface) and the move-note
// picker — must show private-space folders only. A team folder offered as a
// personal target draws a server 400 that silently strands the note, and a
// long-press delete on one tombstones teammates' notes server-side.
//
// These tests drive the REAL useNotesStore against a mocked repository, so they
// cover the whole chain the fix touches: getPrivateFolders → store.folders →
// the rendered list / the picker's `folders` prop.
//
// useNotesStore pulls in a long chain of stores/services at module scope; the
// mock set below mirrors the one proven safe by useNotesStore.spaces.test.ts.
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
}));
jest.mock('@/data/remote/notesApi', () => ({
  deleteNote: jest.fn(),
}));
jest.mock('@/lib/uuid', () => ({
  randomUUID: () => 'test-uuid',
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getFolders: jest.fn(() => []),
    getPrivateFolders: jest.fn(() => []),
    getFolderCounts: jest.fn(() => ({})),
    getNotesByFolder: jest.fn(() => []),
    getNotesBySpace: jest.fn(() => []),
    getAllNotes: jest.fn(() => []),
    getSpeakerProfiles: jest.fn(() => []),
    searchNotes: jest.fn(() => []),
  },
  spacesRepository: {
    listSpaces: jest.fn(() => []),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: { autoGenerateNoteTitle: false } }) },
}));
jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: jest.fn(),
  deriveLocalTitle: jest.fn(),
}));
jest.mock('@/lib/localReasoningFallback', () => ({
  promptLocalReasoningFallback: jest.fn(),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/services/diarization/DiarizationService', () => ({
  processMeeting: jest.fn(),
}));
jest.mock('@/lib/diarization/getDiarizer', () => ({
  getDiarizer: jest.fn(),
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    transcribe: jest.fn(),
    isAvailable: jest.fn(() => true),
    isReadyForLanguage: jest.fn(async () => true),
  },
}));

// Chrome the folder list doesn't need: each drags in glass/superwall/native
// deps that have nothing to do with which folders are shown.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));
jest.mock('@/components/notes/NotesTopBar', () => ({ NotesTopBar: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/components/ui/Fab', () => ({
  Fab: () => null,
  FAB_BOTTOM_PADDING: 0,
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: (selector: (state: { status: string }) => unknown) => selector({ status: 'idle' }),
}));
jest.mock('@/components/notes/NoteRow', () => ({ NoteRow: () => null }));
jest.mock('@/components/notes/NewFolderSheet', () => ({ NewFolderSheet: () => null }));
jest.mock('@/components/notes/SectionHeader', () => ({
  SectionHeader: ({ label }: { label: string }) =>
    require('react').createElement(require('react-native').Text, null, label),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({ GlassIconButton: () => null }));

import { render } from '@testing-library/react-native';
import FoldersScreen from '@/screens/FoldersScreen';
import { MoveToFolderSheet } from '@/components/notes/MoveToFolderSheet';
import { useNotesStore } from '@/store/useNotesStore';
import { notesRepository } from '@/data';
import type { Folder } from '@/data/types';

const mockNotesRepository = notesRepository as jest.Mocked<typeof notesRepository>;

const folder = (overrides: Partial<Folder> = {}): Folder =>
  ({
    id: 1,
    name: 'Personal',
    isDefault: 0,
    sortOrder: 0,
    deletedAt: null,
    spaceId: 1,
    ...overrides,
  }) as Folder;

const PRIVATE_FOLDER = folder({ id: 1, name: 'Groceries', spaceId: 1 });
const TEAM_FOLDER = folder({ id: 2, name: 'Q3 Roadmap', spaceId: 2 });

beforeEach(() => {
  jest.clearAllMocks();
  useNotesStore.setState({
    folders: [],
    folderCounts: {},
    notes: [],
    spaces: [],
    activeFolderId: null,
    activeSpaceId: null,
    isInitialized: false,
  });
  // The repository holds both; only the private-space view is UI-facing.
  mockNotesRepository.getFolders.mockReturnValue([PRIVATE_FOLDER, TEAM_FOLDER]);
  mockNotesRepository.getPrivateFolders.mockReturnValue([PRIVATE_FOLDER]);
});

describe('FoldersScreen — folder browsing list', () => {
  it('lists private-space folders only, even when team folders exist locally', () => {
    const { queryByText } = render(<FoldersScreen />);

    expect(queryByText('Groceries')).not.toBeNull();
    // Team folders are reachable through the Spaces section instead. Listing
    // one here would also make it a long-press rename/delete target.
    expect(queryByText('Q3 Roadmap')).toBeNull();
  });
});

describe('MoveToFolderSheet — move-note folder picker', () => {
  it('offers only the private-space folders the store holds', () => {
    useNotesStore.getState().initialize();
    // Exactly what NotesListScreen hands the sheet: `folders={folders}` off the store.
    const { folders, folderCounts } = useNotesStore.getState();

    const { queryByText } = render(
      <MoveToFolderSheet
        visible
        folders={folders}
        folderCounts={folderCounts}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
      />,
    );

    expect(queryByText('Groceries')).not.toBeNull();
    // Picking a team folder for a personal note draws a server 400, which T2
    // classifies as terminal — the note then stops syncing, silently.
    expect(queryByText('Q3 Roadmap')).toBeNull();
  });
});
