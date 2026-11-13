// The Folders screen shows one workspace at a time once the API keeps a Private per workspace,
// as desktop does: the active workspace's Private and its team spaces, picked in a switcher.
import { createMemoryRepository, type TestDb } from '@/data/local/__tests__/testDb';
import { LocalSpacesRepository } from '@/data/local/spacesRepository';
import type { LocalNotesRepository } from '@/data/local/notesRepository';

let mockRepo: LocalNotesRepository;
let mockSpaces: LocalSpacesRepository;
let mockDatabase: TestDb;

jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => undefined) }));
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
  get spacesRepository() {
    return mockSpaces;
  },
}));
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('@sentry/react-native', () => ({ captureException: jest.fn() }));
jest.mock('@/data/remote/notesApi', () => ({ deleteNote: jest.fn() }));
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
jest.mock('@/lib/localReasoningFallback', () => ({ promptLocalReasoningFallback: jest.fn() }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/services/diarization/DiarizationService', () => ({ processMeeting: jest.fn() }));
jest.mock('@/lib/diarization/getDiarizer', () => ({ getDiarizer: jest.fn() }));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { transcribe: jest.fn(), isAvailable: jest.fn(() => true) },
}));
jest.mock('@react-native-menu/menu', () =>
  require('../../components/notes/__tests__/menuViewMock'),
);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/notes/NotesTopBar', () => ({ NotesTopBar: () => null }));
jest.mock('@/components/notes/SyncStatusLabel', () => ({ SyncStatusLabel: () => null }));
jest.mock('@/components/ui/Fab', () => {
  const { Pressable, Text } = require('react-native');
  return {
    FAB_BOTTOM_PADDING: 0,
    Fab: ({ onActionPress }: { onActionPress: (id: string) => void }) => (
      <Pressable testID="fab-note" onPress={() => onActionPress('note')}>
        <Text>New Note</Text>
      </Pressable>
    ),
  };
});
jest.mock('@/hooks/useManualSyncRefresh', () => ({
  useManualSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
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
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

import { act, fireEvent, render } from '@testing-library/react-native';
import FoldersScreen from '@/screens/FoldersScreen';
import { useNotesStore } from '@/store/useNotesStore';

const OWN = 'workspace-own';
const ACME = 'workspace-acme';

beforeEach(() => {
  const memory = createMemoryRepository();
  mockRepo = memory.repo;
  mockDatabase = memory.db;
  mockSpaces = new LocalSpacesRepository(
    memory.db as unknown as ConstructorParameters<typeof LocalSpacesRepository>[0],
  );
  useNotesStore.setState({
    folders: [],
    notes: [],
    spaces: [],
    activeFolderId: null,
    activeSpaceId: null,
    isInitialized: false,
  });

  mockRepo.createFolder('Personal', undefined, { isDefault: true });
  mockRepo.createFolder('Groceries');
  mockRepo.createFolder('Personal', undefined, { isDefault: true, privateWorkspaceId: ACME });
  mockRepo.createFolder('Roadmap notes', undefined, { privateWorkspaceId: ACME });
  mockSpaces.upsertFromRemote(
    { id: 'own-space', workspace_id: OWN, name: 'Family', my_role: 'admin' },
    'Mine',
  );
  mockSpaces.upsertFromRemote(
    { id: 'acme-space', workspace_id: ACME, name: 'Engineering', my_role: 'member' },
    'Acme',
  );
  mockRepo.setSyncState('private_workspace_placement', 'true');
  mockRepo.setSyncState('private_default_workspace_id', OWN);
  mockRepo.setSyncState(
    'private_workspaces',
    JSON.stringify([
      { id: OWN, name: 'Mine', is_default: true },
      { id: ACME, name: 'Acme' },
    ]),
  );
});

it('shows the active workspace’s Private and team spaces, and switches between workspaces', () => {
  const screen = render(<FoldersScreen />);
  expect(screen.getByLabelText('Workspace: Mine')).toBeTruthy();
  expect(screen.getAllByText('Personal')).toHaveLength(1);
  expect(screen.queryByText('Groceries')).not.toBeNull();
  expect(screen.queryByText('Roadmap notes')).toBeNull();
  expect(screen.queryByText('Family')).not.toBeNull();
  expect(screen.queryByText('Engineering')).toBeNull();

  act(() => {
    fireEvent.press(screen.getByTestId(`menu-${ACME}`));
  });
  expect(screen.getByLabelText('Workspace: Acme')).toBeTruthy();
  expect(screen.getAllByText('Personal')).toHaveLength(1);
  expect(screen.queryByText('Roadmap notes')).not.toBeNull();
  expect(screen.queryByText('Groceries')).toBeNull();
  expect(screen.queryByText('Engineering')).not.toBeNull();
  expect(screen.queryByText('Family')).toBeNull();
});

it('files a note composed from the Folders screen in the active workspace’s Personal', () => {
  mockRepo.setSyncState('private_active_workspace_id', ACME);
  const screen = render(<FoldersScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('fab-note'));
  });
  const [note] = mockRepo.getAllNotes();
  const acmePersonal = mockRepo
    .getPrivateFolders()
    .find((f) => f.name === 'Personal' && f.privateWorkspaceId === ACME);
  expect(note.folderId).toBe(acmePersonal?.id);
});

it('keeps today’s single Private list when the API has no per-workspace Private', () => {
  mockRepo.setSyncState('private_workspace_placement', 'false');
  const screen = render(<FoldersScreen />);
  expect(screen.queryByLabelText(/^Workspace:/)).toBeNull();
  expect(screen.queryByText('Family')).not.toBeNull();
  expect(screen.queryByText('Engineering')).not.toBeNull();
});

it('keeps legacy folders selectable beside a single workspace before a default exists', () => {
  mockRepo.setSyncState('private_default_workspace_id', '');
  mockRepo.setSyncState('private_workspaces', JSON.stringify([{ id: ACME, name: 'Acme' }]));
  const screen = render(<FoldersScreen />);
  expect(screen.getByLabelText('Workspace: Personal')).toBeTruthy();
  expect(screen.queryByText('Groceries')).not.toBeNull();
  expect(screen.queryByText('Roadmap notes')).toBeNull();

  fireEvent.press(screen.getByTestId(`menu-${ACME}`));
  expect(screen.getByLabelText('Workspace: Acme')).toBeTruthy();
  expect(screen.queryByText('Roadmap notes')).not.toBeNull();
  expect(screen.queryByText('Groceries')).toBeNull();
  expect(screen.queryByText('Engineering')).not.toBeNull();

  fireEvent.press(screen.getByTestId('menu-unassigned-private'));
  expect(screen.getByLabelText('Workspace: Personal')).toBeTruthy();
  expect(screen.queryByText('Groceries')).not.toBeNull();
  fireEvent.press(screen.getByTestId('fab-note'));
  const [note] = mockRepo.getAllNotes();
  expect(
    mockRepo.getFolders().find((folder) => folder.id === note.folderId)?.privateWorkspaceId,
  ).toBeNull();
});
