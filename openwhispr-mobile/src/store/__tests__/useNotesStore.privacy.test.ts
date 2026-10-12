jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/documents/' }));
const mockAuthState = {
  user: { id: 'account', email: 'a@b.com', emailVerified: true },
  isGuest: false,
  isLoading: false,
  sessionCookie: 'cookie',
};
const mockConfigState: {
  config: { autoGenerateNoteTitle: boolean; appleLocalIntelligenceEnabled?: boolean };
} = {
  config: { autoGenerateNoteTitle: false },
};
const mockProcessingModeState: { activeMode: 'cloud' | 'private' } = {
  activeMode: 'cloud',
};

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/data/remote/notesApi', () => ({
  deleteNote: jest.fn(),
  fetchNotes: jest.fn(),
  batchCreateNotes: jest.fn(),
  updateNote: jest.fn(),
}));
jest.mock('@/lib/uuid', () => ({
  randomUUID: () => 'test-uuid',
}));
let mockRepo: import('@/data/local/notesRepository').LocalNotesRepository;
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => mockProcessingModeState },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuthState, subscribe: () => () => {} },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => mockConfigState, subscribe: () => () => {} },
}));
jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: jest.fn(),
  deriveLocalTitle: jest.fn(),
}));
jest.mock('@/lib/localReasoningFallback', () => ({
  promptLocalReasoningFallback: jest.fn(),
}));
jest.mock('@/lib/appsflyer', () => ({
  logTranscriptionCompleted: jest.fn(),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(),
  },
}));
import { useNotesStore } from '../useNotesStore';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { batchCreateNotes, deleteNote, fetchNotes } from '@/data/remote/notesApi';
import { pushPrivateNoteDeletes } from '@/sync/privateNoteDeletion';
import { pushNotes } from '@/sync/pushNotes';
import { SyncCancelledError } from '@/sync/syncContext';
import type { RemoteNote } from '@/data/types';

function remoteNote(deletedAt: string | null = null): RemoteNote {
  return {
    id: 'remote',
    client_note_id: 'client',
    title: 'Cloud note',
    content: 'old',
    folder_id: null,
    enhanced_content: null,
    enhancement_prompt: null,
    transcript: null,
    note_type: 'personal',
    source_file: null,
    audio_duration_seconds: null,
    deleted_at: deletedAt,
    participants: null,
    calendar_event_id: null,
    updated_at: '2026-09-17T13:00:00.000Z',
  };
}

function seed(uploaded = false): number {
  const created = mockRepo.createNote('Keep me', 'local text');
  const note = mockRepo.setNoteClientId(created.id, 'client');
  if (uploaded) mockRepo.markNotePushed(note, 'remote', 'server-time');
  return note.id;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRepo = createMemoryRepository().repo;
  mockAuthState.isGuest = false;
  mockAuthState.isLoading = false;
  useNotesStore.setState({ loadNotes: () => {}, loadFolders: () => {} });
  jest.mocked(fetchNotes).mockResolvedValue({ notes: [], hasMore: false });
  jest.mocked(deleteNote).mockResolvedValue(undefined);
});

it('lets a guest restore the local sync preference without authenticating', async () => {
  const id = seed();
  mockAuthState.isGuest = true;
  await useNotesStore.getState().setNotePrivacy(id, true);
  await useNotesStore.getState().setNotePrivacy(id, false);
  expect(mockRepo.getNoteById(id)).toMatchObject({ isPrivate: 0, pendingSync: 1 });
  expect(deleteNote).not.toHaveBeenCalled();
  expect(fetchNotes).not.toHaveBeenCalled();
});

it('does not recover a cloud copy for a never-uploaded private note', async () => {
  const id = seed();
  await useNotesStore.getState().setNotePrivacy(id, true);
  await pushPrivateNoteDeletes();
  await useNotesStore.getState().setNotePrivacy(id, false);
  await pushPrivateNoteDeletes();
  expect(mockRepo.getNoteById(id)).toMatchObject({ isPrivate: 0, content: 'local text' });
  expect(deleteNote).not.toHaveBeenCalled();
  expect(fetchNotes).not.toHaveBeenCalled();
});

it('publishes a fresh identity while retaining a lost create for later cleanup', async () => {
  const id = seed();
  jest.mocked(batchCreateNotes).mockRejectedValueOnce(new Error('Response lost'));
  await expect(pushNotes()).rejects.toThrow();
  mockRepo.setNotePrivacy(id, true);
  await useNotesStore.getState().setNotePrivacy(id, false);
  expect(mockRepo.getNoteById(id)).toMatchObject({
    clientNoteId: 'test-uuid',
    remoteId: null,
    cloudUpdatedAt: null,
    isPrivate: 0,
    pendingSync: 1,
  });
  const tombstone = remoteNote('2026-09-17T13:00:00.000Z');
  mockRepo.applyRemoteNote(tombstone, () => null);
  expect(mockRepo.getNoteById(id)?.content).toBe('local text');

  jest.mocked(fetchNotes).mockResolvedValue({ notes: [remoteNote()], hasMore: false });
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledWith('remote');
  expect(mockRepo.getNoteById(id)).toMatchObject({ clientNoteId: 'test-uuid', isPrivate: 0 });
  jest.mocked(deleteNote).mockClear();
  await pushPrivateNoteDeletes();
  expect(deleteNote).not.toHaveBeenCalled();
});

it('keeps deletion recoverable when a note becomes private during its first upload', async () => {
  const id = seed();
  jest.mocked(batchCreateNotes).mockImplementationOnce(async () => {
    await expect(useNotesStore.getState().setNotePrivacy(id, true)).rejects.toThrow();
    return [remoteNote()];
  });
  await pushNotes();
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledWith('remote');
  expect(mockRepo.getNoteById(id)).toMatchObject({
    isPrivate: 1,
    remoteId: null,
    clientNoteId: null,
    content: 'local text',
  });
});

it('does not mark an upload cancelled before sending as needing cloud cleanup', async () => {
  const id = seed();
  await expect(
    pushNotes(false, (upload) => {
      if (upload) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  await useNotesStore.getState().setNotePrivacy(id, true);
  await pushPrivateNoteDeletes();
  expect(batchCreateNotes).not.toHaveBeenCalled();
  expect(fetchNotes).not.toHaveBeenCalled();
  expect(deleteNote).not.toHaveBeenCalled();
});

it('does not let a failed cleanup block publication or overwrite the fresh identity', async () => {
  const id = seed(true);
  jest.mocked(deleteNote).mockRejectedValueOnce(new Error('offline'));
  await expect(useNotesStore.getState().setNotePrivacy(id, true)).rejects.toThrow('offline');
  await useNotesStore.getState().setNotePrivacy(id, false);
  expect(mockRepo.getNoteById(id)).toMatchObject({
    clientNoteId: 'test-uuid',
    remoteId: null,
    cloudUpdatedAt: null,
    isPrivate: 0,
  });
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenLastCalledWith('remote');
  expect(mockRepo.getNoteById(id)).toMatchObject({
    clientNoteId: 'test-uuid',
    remoteId: null,
    isPrivate: 0,
    content: 'local text',
  });
});

it('does not rotate an already public identity on a repeated enable action', async () => {
  const id = seed(true);
  await useNotesStore.getState().setNotePrivacy(id, false);
  expect(mockRepo.getNoteById(id)).toMatchObject({ clientNoteId: 'client', remoteId: 'remote' });
  expect(deleteNote).not.toHaveBeenCalled();
});

it('does not report a stale privacy error after the user publishes the note', async () => {
  const id = seed(true);
  let rejectDelete!: (error: Error) => void;
  jest.mocked(deleteNote).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectDelete = reject;
      }),
  );
  const goingPrivate = useNotesStore.getState().setNotePrivacy(id, true);
  await useNotesStore.getState().setNotePrivacy(id, false);
  rejectDelete(new Error('offline'));
  await expect(goingPrivate).resolves.toBeUndefined();
  expect(mockRepo.getNoteById(id)).toMatchObject({ isPrivate: 0, clientNoteId: 'test-uuid' });
});
