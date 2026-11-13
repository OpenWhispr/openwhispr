// Every workspace has its own Private section (desktop PR #3167). Once mobile asks the API for
// all of them, each workspace's Private brings its own "Personal" and "Meetings", and the
// names tie. These tests drive the real store against an in-memory repository.
import { createMemoryRepository, type TestDb } from '@/data/local/__tests__/testDb';
import { LocalSpacesRepository } from '@/data/local/spacesRepository';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { RemoteFolder } from '@/data/types';

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

import { useNotesStore } from '../useNotesStore';

const OWN = 'workspace-own';
const ACME = 'workspace-acme';

const remoteFolder = (over: Partial<RemoteFolder>): RemoteFolder => ({
  id: 'srv',
  client_folder_id: null,
  name: 'Folder',
  is_default: true,
  sort_order: 0,
  deleted_at: null,
  updated_at: '2026-11-12T10:00:00.000Z',
  ...over,
});

const folderNamed = (name: string, workspaceId: string | null) =>
  mockRepo
    .getPrivateFolders()
    .find((f) => f.name === name && (f.privateWorkspaceId ?? OWN) === (workspaceId ?? OWN))!;

function seedTwoPrivates(): void {
  // This device's own seeded folders: unplaced, so the default workspace's.
  mockRepo.createFolder('Personal', undefined, { isDefault: true, sortOrder: 0 });
  mockRepo.createFolder('Meetings', undefined, { isDefault: true, sortOrder: 1 });
  // Acme's Private, pulled from the cloud.
  mockRepo.applyRemoteFolder(
    remoteFolder({ id: 'acme-personal', name: 'Personal', private_workspace_id: ACME }),
  );
  mockRepo.applyRemoteFolder(
    remoteFolder({
      id: 'acme-meetings',
      name: 'Meetings',
      sort_order: 1,
      private_workspace_id: ACME,
    }),
  );
}

function setPlacement(options: { active?: string } = {}): void {
  mockRepo.setSyncState('private_workspace_placement', 'true');
  mockRepo.setSyncState('private_default_workspace_id', OWN);
  mockRepo.setSyncState(
    'private_workspaces',
    JSON.stringify([
      { id: ACME, name: 'Acme' },
      { id: OWN, name: 'Mine', is_default: true },
    ]),
  );
  if (options.active) mockRepo.setSyncState('private_active_workspace_id', options.active);
}

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
    activeNoteId: null,
    isInitialized: false,
  });
});

describe('the folders on screen', () => {
  it('lists only the active workspace’s Private, never two Personal folders', () => {
    seedTwoPrivates();
    setPlacement();
    useNotesStore.getState().initialize();
    const { folders, activeFolderId, activePrivateWorkspaceId } = useNotesStore.getState();
    expect(activePrivateWorkspaceId).toBe(OWN);
    expect(folders.map((f) => [f.name, f.privateWorkspaceId])).toEqual([
      ['Personal', null],
      ['Meetings', null],
    ]);
    expect(activeFolderId).toBe(folderNamed('Personal', null).id);
  });

  it('switches to another workspace’s Private and remembers the choice', () => {
    seedTwoPrivates();
    setPlacement();
    useNotesStore.getState().initialize();
    useNotesStore.getState().setActivePrivateWorkspace(ACME);
    const { folders, activeFolderId } = useNotesStore.getState();
    expect(folders.map((f) => [f.name, f.privateWorkspaceId])).toEqual([
      ['Personal', ACME],
      ['Meetings', ACME],
    ]);
    expect(activeFolderId).toBe(folderNamed('Personal', ACME).id);
    expect(mockRepo.getSyncState('private_active_workspace_id')).toBe(ACME);
  });

  it('shows the default Private alone until the API keeps one per workspace', () => {
    mockRepo.createFolder('Personal', undefined, { isDefault: true });
    mockRepo.setSyncState('private_active_workspace_id', ACME);
    useNotesStore.getState().initialize();
    expect(useNotesStore.getState().folders.map((f) => f.name)).toEqual(['Personal']);
    expect(useNotesStore.getState().privateWorkspaces).toEqual([]);
  });
});

describe('where new notes and meetings go', () => {
  it('files a new note in the active workspace’s Personal', () => {
    seedTwoPrivates();
    setPlacement({ active: ACME });
    useNotesStore.getState().initialize();
    useNotesStore.setState({ activeFolderId: null });
    const note = useNotesStore.getState().createNote();
    expect(note.folderId).toBe(folderNamed('Personal', ACME).id);

    useNotesStore.getState().setActivePrivateWorkspace(OWN);
    useNotesStore.setState({ activeFolderId: null });
    expect(useNotesStore.getState().createNote().folderId).toBe(folderNamed('Personal', null).id);
  });

  it('files a meeting in the active workspace’s Meetings, even when another’s sorts first', () => {
    seedTwoPrivates();
    setPlacement({ active: OWN });
    useNotesStore.getState().initialize();
    const meeting = useNotesStore.getState().createMeetingNote();
    expect(meeting.folderId).toBe(folderNamed('Meetings', null).id);

    useNotesStore.getState().setActivePrivateWorkspace(ACME);
    expect(useNotesStore.getState().createMeetingNote().folderId).toBe(
      folderNamed('Meetings', ACME).id,
    );
  });

  it('gives an empty Private its own Personal and Meetings the first time a note needs one', () => {
    mockRepo.createFolder('Personal', undefined, { isDefault: true, sortOrder: 0 });
    mockRepo.createFolder('Meetings', undefined, { isDefault: true, sortOrder: 1 });
    setPlacement({ active: ACME });
    useNotesStore.getState().initialize();
    expect(useNotesStore.getState().folders).toEqual([]);

    const meeting = useNotesStore.getState().createMeetingNote();
    const acme = mockRepo.getPrivateFolders().filter((f) => f.privateWorkspaceId === ACME);
    expect(acme.map((f) => [f.name, f.isDefault, f.clientFolderId != null])).toEqual(
      expect.arrayContaining([
        ['Personal', 1, expect.any(Boolean)],
        ['Meetings', 1, expect.any(Boolean)],
      ]),
    );
    expect(acme).toHaveLength(2);
    expect(meeting.folderId).toBe(folderNamed('Meetings', ACME).id);
    expect(useNotesStore.getState().createNote().folderId).toBe(folderNamed('Personal', ACME).id);
    // Nothing was added to the default's Private.
    expect(mockRepo.getPrivateFolders().filter((f) => f.privateWorkspaceId == null)).toHaveLength(
      2,
    );
  });

  it('creates a folder in the active workspace’s Private', () => {
    seedTwoPrivates();
    setPlacement({ active: ACME });
    useNotesStore.getState().initialize();
    const folder = useNotesStore.getState().createFolder('Ideas');
    expect(folder.privateWorkspaceId).toBe(ACME);
    expect(useNotesStore.getState().folders.map((f) => f.name)).toContain('Ideas');
  });

  it('falls back within the active workspace after deleting the folder on screen', () => {
    seedTwoPrivates();
    setPlacement({ active: ACME });
    useNotesStore.getState().initialize();
    const ideas = useNotesStore.getState().createFolder('Ideas');
    useNotesStore.getState().setActiveFolderId(ideas.id);
    useNotesStore.getState().deleteFolderSafe(ideas.id);
    expect(useNotesStore.getState().activeFolderId).toBe(folderNamed('Personal', ACME).id);
  });
});
