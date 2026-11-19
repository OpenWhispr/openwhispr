// Every workspace has its own Private section (desktop PR #3167). Once mobile asks the API for
// all of them, each workspace's Private brings its own "Personal" and "Meetings", and the
// names tie. These tests drive the real store against an in-memory repository.
import { createMemoryRepository, type TestDb } from '@/data/local/__tests__/testDb';
import { LocalSpacesRepository } from '@/data/local/spacesRepository';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { Folder } from '@/data/types';
import { sql } from 'drizzle-orm';

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

import { useNotesStore } from '@/store/useNotesStore';

import { act, renderHook } from '@testing-library/react-native';
import { useMoveNote, type UseMoveNoteResult } from '../useMoveNote';

const OWN = 'workspace-own';
const ACME = 'workspace-acme';

function renderListMove(): ReturnType<typeof renderHook<UseMoveNoteResult, undefined>> {
  return renderHook((): UseMoveNoteResult => {
    const { folders, activeFolderId } = useNotesStore();
    return useMoveNote({
      scopeSpaceId: null,
      targetFolders: folders,
      excludeFolderId: activeFolderId,
    });
  });
}

function addAcmeFolders(): Folder {
  const folder = mockRepo.createFolder('Acme Personal', undefined, { privateWorkspaceId: ACME });
  mockRepo.setSyncState('private_workspace_placement', 'true');
  mockRepo.setSyncState('private_default_workspace_id', OWN);
  mockRepo.setSyncState(
    'private_workspaces',
    JSON.stringify([
      { id: OWN, name: 'Mine', is_default: true },
      { id: ACME, name: 'Acme', plan: 'enterprise', status: 'active' },
    ]),
  );
  return folder;
}

beforeEach((): void => {
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

it('keeps a list move in the note’s Private after sync changes the active workspace', (): void => {
  const personal = mockRepo.createFolder('Personal', undefined, { isDefault: true });
  const ideas = mockRepo.createFolder('Ideas');
  const note = mockRepo.createNote('Shopping list', 'Groceries', personal.id);
  useNotesStore.getState().initialize();
  useNotesStore.getState().setActiveFolderId(personal.id);
  const { result } = renderListMove();

  act((): void => {
    addAcmeFolders();
    mockSpaces.upsertFromRemote({
      id: 'acme-team',
      workspace_id: ACME,
      name: 'Acme Team',
      my_role: 'admin',
    });
    mockSpaces.upsertFromRemote({
      id: 'own-team',
      workspace_id: OWN,
      name: 'Own Team',
      my_role: 'admin',
    });
    useNotesStore.getState().loadFolders();
    useNotesStore.getState().loadSpaces();
    useNotesStore.getState().loadNotes();
  });
  expect(useNotesStore.getState().activeFolderId).toBe(personal.id);
  expect(useNotesStore.getState().activePrivateWorkspaceId).toBe(ACME);
  act((): void => result.current.open(note.id));

  expect(result.current.sheetProps.folders.map((folder): number => folder.id)).toEqual([
    ideas.id,
    personal.id,
  ]);
  expect(
    result.current.sheetProps.privateGroups?.map((group): string | null => group.workspaceId),
  ).toEqual([ACME]);
  expect(
    result.current.sheetProps.spaces?.map((space): string | null => space.workspaceId),
  ).toEqual([OWN]);
  act((): void => result.current.sheetProps.onCreateAndPick('Shopping archive'));
  const destination = mockRepo
    .getFolders()
    .find((folder): boolean => folder.id === mockRepo.getNoteById(note.id)?.folderId);
  expect(destination?.privateWorkspaceId).toBe(OWN);
});

it('uses the selected team note’s space when the browsing scope differs', (): void => {
  const personal = mockRepo.createFolder('Personal');
  addAcmeFolders();
  const source = mockSpaces.upsertFromRemote({
    id: 'source',
    workspace_id: ACME,
    name: 'Source',
    my_role: 'admin',
  });
  const sibling = mockSpaces.upsertFromRemote({
    id: 'sibling',
    workspace_id: ACME,
    name: 'Sibling',
    my_role: 'admin',
  });
  mockSpaces.upsertFromRemote({
    id: 'other',
    workspace_id: OWN,
    name: 'Other workspace',
    my_role: 'admin',
  });
  const teamFolder = mockRepo.createFolder('Specs', source.id);
  const note = mockRepo.createNote('Team note', '', undefined, source.id);
  useNotesStore.getState().initialize();
  useNotesStore.getState().setActiveFolderId(personal.id);
  const { result } = renderListMove();
  act((): void => result.current.open(note.id));

  expect(result.current.sheetProps.activeSpaceId).toBe(source.id);
  expect(result.current.sheetProps.folders.map((folder): number => folder.id)).toEqual([
    teamFolder.id,
  ]);
  expect(result.current.sheetProps.privateGroups).toEqual([]);
  expect(result.current.sheetProps.spaces?.map((space): number => space.id)).toEqual([sibling.id]);
  act((): void => result.current.sheetProps.onCreateAndPick('Team archive'));
  const destination = mockRepo
    .getFolders()
    .find((folder): boolean => folder.id === mockRepo.getNoteById(note.id)?.folderId);
  expect(destination?.spaceId).toBe(source.id);
  expect(destination?.privateWorkspaceId).toBeNull();
});

it('uses a folderless note’s recorded Private instead of the browsing workspace', (): void => {
  mockRepo.createFolder('Personal');
  const acme = addAcmeFolders();
  const note = mockRepo.createNote('Folderless note', '');
  mockDatabase.run(
    sql`UPDATE notes SET folder_id = NULL, private_workspace_id = ${ACME} WHERE id = ${note.id}`,
  );
  mockRepo.setSyncState('private_active_workspace_id', OWN);
  useNotesStore.getState().initialize();
  const { result } = renderListMove();
  act((): void => result.current.open(note.id));

  expect(result.current.sheetProps.folders.map((folder): number => folder.id)).toEqual([acme.id]);
  expect(
    result.current.sheetProps.privateGroups?.map((group): string | null => group.workspaceId),
  ).toEqual([OWN]);
});

it('creates a destination in the default Private for a note from a departed workspace', (): void => {
  const personal = mockRepo.createFolder('Personal');
  const acme = addAcmeFolders();
  const departed = mockRepo.createFolder('Departed', undefined, { privateWorkspaceId: 'gone' });
  const note = mockRepo.createNote('Recovered note', '', departed.id);
  useNotesStore.getState().initialize();
  const { result } = renderListMove();
  act((): void => result.current.open(note.id));

  expect(result.current.sheetProps.folders.map((folder): number => folder.id)).toEqual([
    personal.id,
  ]);
  expect(
    result.current.sheetProps.privateGroups?.map((group): number[] =>
      group.folders.map((folder): number => folder.id),
    ),
  ).toEqual([[acme.id]]);
  act((): void => result.current.sheetProps.onCreateAndPick('Recovery'));
  const destination = mockRepo
    .getFolders()
    .find((folder): boolean => folder.id === mockRepo.getNoteById(note.id)?.folderId);
  expect(destination?.privateWorkspaceId).toBe(OWN);
});

it('offers no destinations when the selected note’s team space is unavailable', (): void => {
  mockRepo.createFolder('Personal');
  addAcmeFolders();
  mockSpaces.upsertFromRemote({ id: 'team', workspace_id: ACME, name: 'Team', my_role: 'admin' });
  const note = mockRepo.createNote('Unavailable team note', '', undefined, 999);
  useNotesStore.getState().initialize();
  const { result } = renderListMove();
  act((): void => result.current.open(note.id));

  expect(result.current.sheetProps.visible).toBe(false);
  expect(result.current.sheetProps.folders).toEqual([]);
  expect(result.current.sheetProps.privateGroups).toEqual([]);
  expect(result.current.sheetProps.spaces).toEqual([]);
  const beforeFolders = mockRepo.getFolders();
  act((): void => {
    result.current.sheetProps.onCreateAndPick('Unavailable destination');
    result.current.sheetProps.onPickFolder(beforeFolders[0].id);
    result.current.sheetProps.onPickSpace?.(
      mockSpaces.listSpaces().find((space): boolean => space.kind === 'team')!.id,
    );
  });
  expect(mockRepo.getFolders()).toEqual(beforeFolders);
  expect(mockRepo.getNoteById(note.id)).toMatchObject({ spaceId: 999, folderId: null });
});
