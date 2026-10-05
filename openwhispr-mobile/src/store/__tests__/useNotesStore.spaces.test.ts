// useNotesStore.ts pulls in a long chain of stores/services at module scope (diarization,
// reasoning, etc.) — mirror the mock set proven safe by useNotesStore.meeting.test.ts rather than
// guessing which ones this file's code paths actually touch.
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
    getSpaceNotesWithoutFolder: jest.fn(() => []),
    createNote: jest.fn(() => ({ id: 99 })),
    createFolder: jest.fn((name: string) => ({ id: 77, name })),
    setNotePrivacy: jest.fn(),
    getFoldersBySpace: jest.fn(() => []),
    getAllNotes: jest.fn(() => []),
    getSpeakerProfiles: jest.fn(() => []),
    moveNoteToSpace: jest.fn(),
    listConflictedNotes: jest.fn(() => []),
    resolveConflictKeepMine: jest.fn(),
    resolveConflictUseServer: jest.fn(),
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

import { useNotesStore } from '../useNotesStore';
import { notesRepository, spacesRepository } from '@/data';
import type { Folder, Note } from '@/data/types';
import type { Space } from '@/data/spacesTypes';

const mockNotesRepository = notesRepository as jest.Mocked<typeof notesRepository>;
const mockListSpaces = spacesRepository.listSpaces as jest.Mock;

const space = (overrides: Partial<Space> = {}): Space =>
  ({
    id: 1,
    clientSpaceId: 'client-space-1',
    cloudSpaceId: null,
    workspaceId: null,
    kind: 'private',
    name: 'Personal',
    emoji: null,
    sortOrder: 0,
    myRole: null,
    memberCount: 0,
    teams: null,
    syncStatus: 'synced',
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Space;

const folder = (overrides: Partial<Folder> = {}): Folder =>
  ({
    id: 1,
    name: 'Personal',
    isDefault: 1,
    sortOrder: 0,
    deletedAt: null,
    ...overrides,
  }) as Folder;

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 1,
    title: 'Note',
    content: '',
    folderId: 1,
    spaceId: 1,
    conflictServerNote: null,
    ...overrides,
  }) as Note;

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
  mockListSpaces.mockReturnValue([
    space({ id: 1, kind: 'private', name: 'Personal' }),
    space({ id: 2, kind: 'team', name: 'Engineering' }),
  ]);
});

describe('useNotesStore — spaces', () => {
  it('initialize() populates spaces alongside folders/notes', () => {
    useNotesStore.getState().initialize();

    expect(useNotesStore.getState().spaces.map((s) => s.id)).toEqual([1, 2]);
  });

  // Fix round 2, Finding 3: team-space folders must never reach a personal
  // folder surface — offering one as a move target draws a server 400 that
  // silently strands the note, and deleting one tombstones teammates' notes.
  it('initialize() populates folders from the private-space view only', () => {
    const personalFolder = folder({ id: 3, name: 'Personal folder' });
    mockNotesRepository.getPrivateFolders.mockReturnValue([personalFolder]);

    useNotesStore.getState().initialize();

    expect(mockNotesRepository.getPrivateFolders).toHaveBeenCalled();
    expect(mockNotesRepository.getFolders).not.toHaveBeenCalled();
    expect(useNotesStore.getState().folders).toEqual([personalFolder]);
  });

  it('loadFolders() refreshes from the private-space view too', () => {
    useNotesStore.getState().loadFolders();

    expect(mockNotesRepository.getPrivateFolders).toHaveBeenCalled();
    expect(mockNotesRepository.getFolders).not.toHaveBeenCalled();
  });

  it('loadSpaces() refreshes spaces from the repository', () => {
    mockListSpaces.mockReturnValueOnce([space({ id: 1 })]);
    useNotesStore.getState().loadSpaces();
    expect(useNotesStore.getState().spaces).toHaveLength(1);

    mockListSpaces.mockReturnValueOnce([space({ id: 1 }), space({ id: 2 })]);
    useNotesStore.getState().loadSpaces();
    expect(useNotesStore.getState().spaces).toHaveLength(2);
  });

  // Browsing a space lists its folders above its notes, so the note list must
  // exclude anything a folder row already accounts for.
  it('setActiveSpaceId(id) loads the space folders and its unfoldered notes, and clears activeFolderId', () => {
    const teamNotes = [note({ id: 10, spaceId: 2 })];
    const teamFolders = [{ id: 30, name: 'Specs', spaceId: 2 } as never];
    mockNotesRepository.getSpaceNotesWithoutFolder.mockReturnValue(teamNotes);
    mockNotesRepository.getFoldersBySpace.mockReturnValue(teamFolders);
    useNotesStore.setState({ activeFolderId: 5 });

    useNotesStore.getState().setActiveSpaceId(2);

    expect(mockNotesRepository.getSpaceNotesWithoutFolder).toHaveBeenCalledWith(2);
    expect(mockNotesRepository.getFoldersBySpace).toHaveBeenCalledWith(2);
    expect(useNotesStore.getState().notes).toEqual(teamNotes);
    expect(useNotesStore.getState().spaceFolders).toEqual(teamFolders);
    expect(useNotesStore.getState().activeSpaceId).toBe(2);
    expect(useNotesStore.getState().activeFolderId).toBeNull();
  });

  // Regression: creating a note while browsing a space used to fall back to the
  // personal default folder, silently filing it outside the space.
  it('createNote() while browsing a space files the note into that space', () => {
    useNotesStore.setState({ activeFolderId: null, activeSpaceId: 2 });

    useNotesStore.getState().createNote();

    expect(mockNotesRepository.createNote).toHaveBeenCalledWith('Untitled', '', undefined, 2);
  });

  it('createNote() still uses the active folder when no space is being browsed', () => {
    useNotesStore.setState({ activeFolderId: 5, activeSpaceId: null });

    useNotesStore.getState().createNote();

    expect(mockNotesRepository.createNote).toHaveBeenCalledWith('Untitled', '', 5);
  });

  it('createFolder(name, spaceId) creates the folder inside that space', () => {
    useNotesStore.getState().createFolder('Specs', 2);

    expect(mockNotesRepository.createFolder).toHaveBeenCalledWith('Specs', 2);
  });

  it('setActiveSpaceId(null) clears the space folder list', () => {
    useNotesStore.setState({ spaceFolders: [{ id: 30 } as never] });

    useNotesStore.getState().setActiveSpaceId(null);

    expect(useNotesStore.getState().spaceFolders).toEqual([]);
  });

  it('setActiveSpaceId(null) falls back to getAllNotes()', () => {
    useNotesStore.getState().setActiveSpaceId(null);
    expect(mockNotesRepository.getAllNotes).toHaveBeenCalled();
  });

  it('setActiveFolderId clears activeSpaceId (mutually exclusive with folder browsing)', () => {
    useNotesStore.setState({ activeSpaceId: 2 });

    useNotesStore.getState().setActiveFolderId(1);

    expect(useNotesStore.getState().activeSpaceId).toBeNull();
  });

  it('loadNotes() reloads via the active space when no folder is active', () => {
    useNotesStore.setState({ activeFolderId: null, activeSpaceId: 2 });
    const teamNotes = [note({ id: 11, spaceId: 2 })];
    mockNotesRepository.getSpaceNotesWithoutFolder.mockReturnValue(teamNotes);

    useNotesStore.getState().loadNotes();

    expect(mockNotesRepository.getSpaceNotesWithoutFolder).toHaveBeenCalledWith(2);
    expect(useNotesStore.getState().notes).toEqual(teamNotes);
  });

  it('loadNotes() prefers the active folder over the active space when both happen to be set', () => {
    useNotesStore.setState({ activeFolderId: 5, activeSpaceId: 2 });

    useNotesStore.getState().loadNotes();

    expect(mockNotesRepository.getNotesByFolder).toHaveBeenCalledWith(5);
    expect(mockNotesRepository.getSpaceNotesWithoutFolder).not.toHaveBeenCalled();
  });

  it('moveNoteToSpace() delegates to the repository, then reloads notes and folders', () => {
    useNotesStore.getState().moveNoteToSpace(7, 2);

    expect(mockNotesRepository.moveNoteToSpace).toHaveBeenCalledWith(7, 2);
    expect(mockNotesRepository.getPrivateFolders).toHaveBeenCalled();
  });
});

describe('useNotesStore — conflict resolution', () => {
  it('getConflictedNote(noteId) returns the matching parked conflict', () => {
    mockNotesRepository.listConflictedNotes.mockReturnValue([
      { id: 7, title: 'Note', conflictServerNote: null },
    ]);

    expect(useNotesStore.getState().getConflictedNote(7)).toEqual({
      id: 7,
      title: 'Note',
      conflictServerNote: null,
    });
    expect(useNotesStore.getState().getConflictedNote(99)).toBeNull();
  });

  it('resolveConflictKeepMine(noteId) calls the repository primitive and reloads notes', () => {
    useNotesStore.getState().resolveConflictKeepMine(7);

    expect(mockNotesRepository.resolveConflictKeepMine).toHaveBeenCalledWith(7);
    expect(mockNotesRepository.getAllNotes).toHaveBeenCalled();
  });

  it('resolveConflictUseServer(noteId) calls the repository primitive and reloads notes', () => {
    useNotesStore.getState().resolveConflictUseServer(7);

    expect(mockNotesRepository.resolveConflictUseServer).toHaveBeenCalledWith(7);
    expect(mockNotesRepository.getAllNotes).toHaveBeenCalled();
  });
});
