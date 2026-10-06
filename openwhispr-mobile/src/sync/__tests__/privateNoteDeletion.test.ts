import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { RemoteNote } from '@/data/types';

let mockRepo: LocalNotesRepository;
const mockAuth = { user: { id: 'account-a' }, sessionCookie: 'cookie-a' };
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
jest.mock('@/data/remote/notesApi', () => ({ deleteNote: jest.fn(), fetchNotes: jest.fn() }));
import { deleteNote, fetchNotes } from '@/data/remote/notesApi';
import {
  clearPrivateNoteDeletionQueue,
  deletePrivateNoteCloudCopy,
  pushPrivateNoteDeletes,
  queuePrivateNoteDeletion,
} from '../privateNoteDeletion';
import { SyncCancelledError } from '../syncContext';
import { recordNoteCreateAttempts } from '../noteCreateAttempts';

beforeEach(() => {
  jest.resetAllMocks();
  mockRepo = createMemoryRepository().repo;
  mockAuth.user = { id: 'account-a' };
  mockAuth.sessionCookie = 'cookie-a';
  jest.mocked(fetchNotes).mockResolvedValue({ notes: [], hasMore: false });
});

function privateNote(
  suffix = '',
  hasRemote = true,
): ReturnType<LocalNotesRepository['createNote']> {
  const created = mockRepo.createNote('Private', 'keep this');
  const note = mockRepo.setNoteClientId(created.id, `client${suffix}`);
  if (hasRemote) mockRepo.markNotePushed(note, `remote${suffix}`, 'server-time');
  else recordNoteCreateAttempts([`client${suffix}`]);
  mockRepo.setNotePrivacy(note.id, true);
  return mockRepo.getNoteById(note.id)!;
}

function remoteNote(overrides: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: 'remote',
    client_note_id: 'client',
    title: 'Remote title',
    content: 'do not import',
    folder_id: null,
    enhanced_content: null,
    enhancement_prompt: null,
    transcript: null,
    note_type: 'personal',
    source_file: null,
    audio_duration_seconds: null,
    deleted_at: null,
    participants: null,
    calendar_event_id: null,
    updated_at: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

it('keeps identifiers offline and retries successfully without a recovery crawl', async () => {
  const note = privateNote();
  jest.mocked(deleteNote).mockRejectedValueOnce(new Error('offline'));
  await expect(pushPrivateNoteDeletes()).rejects.toThrow('offline');
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: 'remote',
    clientNoteId: 'client',
  });
  jest.mocked(deleteNote).mockResolvedValueOnce(undefined);
  await pushPrivateNoteDeletes();
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: null,
    clientNoteId: null,
    content: 'keep this',
    isPrivate: 1,
  });
  expect(fetchNotes).not.toHaveBeenCalled();
});

it('settles a lost DELETE acknowledgement when a 404 is confirmed by a tombstone', async () => {
  const note = privateNote();
  jest.mocked(deleteNote).mockRejectedValue({ status: 404 });
  jest.mocked(fetchNotes).mockResolvedValue({ notes: [remoteNote({ deleted_at: 'deleted' })] });
  await deletePrivateNoteCloudCopy(note);
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: null,
    clientNoteId: null,
    content: 'keep this',
  });
});

it.each([
  { notes: [] },
  { notes: [remoteNote({ access_removed: true })] },
  { notes: [remoteNote({ access_removed: true, deleted_at: 'deleted' })] },
])('does not mistake absent or revoked access for a confirmed deletion (%j)', async ({ notes }) => {
  const note = privateNote();
  jest.mocked(deleteNote).mockRejectedValue({ status: 404, code: 'space_not_found' });
  jest.mocked(fetchNotes).mockResolvedValue({ notes });
  await expect(deletePrivateNoteCloudCopy(note)).rejects.toMatchObject({ status: 404 });
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: 'remote',
    clientNoteId: 'client',
  });
});

it('recovers a lost create identity without importing cloud content or requiring backup', async () => {
  const note = privateNote('', false);
  jest.mocked(fetchNotes).mockResolvedValue({ notes: [remoteNote()] });
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await deletePrivateNoteCloudCopy(note);
  expect(deleteNote).toHaveBeenCalledWith('remote');
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: null,
    clientNoteId: null,
    content: 'keep this',
  });
  expect(fetchNotes).toHaveBeenCalledWith(
    expect.objectContaining({ since: '1970-01-01T00:00:00.000Z', scope: 'all' }),
  );
});

it('keeps an unresolved lost-create identity pending after an empty crawl', async () => {
  const note = privateNote('', false);
  await expect(deletePrivateNoteCloudCopy(note)).rejects.toThrow();
  expect(mockRepo.getNoteById(note.id)!.clientNoteId).toBe('client');
  expect(deleteNote).not.toHaveBeenCalled();
});

it('retired cleanup survives publication and never detaches the new public identity', async () => {
  const note = privateNote();
  queuePrivateNoteDeletion(note);
  mockRepo.clearNoteRemoteId(note.id);
  mockRepo.setNotePrivacy(note.id, false);
  const published = mockRepo.setNoteClientId(note.id, 'new-client');
  mockRepo.markNotePushed(published, 'new-remote', 'new-time');
  jest.mocked(deleteNote).mockRejectedValueOnce(new Error('offline'));
  await expect(pushPrivateNoteDeletes()).rejects.toThrow('offline');
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await pushPrivateNoteDeletes();
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledTimes(2);
  expect(deleteNote).toHaveBeenLastCalledWith('remote');
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    remoteId: 'new-remote',
    clientNoteId: 'new-client',
    isPrivate: 0,
  });
});

it('deduplicates queued and local cleanup identities', async () => {
  const note = privateNote();
  queuePrivateNoteDeletion(note);
  queuePrivateNoteDeletion(note);
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await pushPrivateNoteDeletes();
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledTimes(1);
});

it('crawls once for multiple queued unknown identities and resumes with a composite cursor', async () => {
  const first = privateNote('-first', false);
  const second = privateNote('-second', false);
  queuePrivateNoteDeletion(first);
  queuePrivateNoteDeletion(second);
  mockRepo.setNotePrivacy(first.id, false);
  mockRepo.setNotePrivacy(second.id, false);
  const page = Array.from({ length: 200 }, (_, index) =>
    remoteNote({ id: `other-${index}`, client_note_id: `other-client-${index}` }),
  );
  jest
    .mocked(fetchNotes)
    .mockResolvedValueOnce({ notes: page, hasMore: true })
    .mockResolvedValueOnce({
      notes: [
        remoteNote({ id: 'remote-first', client_note_id: 'client-first' }),
        remoteNote({ id: 'remote-second', client_note_id: 'client-second', deleted_at: 'deleted' }),
      ],
      hasMore: false,
    });
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await pushPrivateNoteDeletes();
  expect(fetchNotes).toHaveBeenCalledTimes(2);
  expect(fetchNotes).toHaveBeenLastCalledWith(
    expect.objectContaining({ since: page[199].updated_at, sinceId: page[199].id, scope: 'all' }),
  );
  expect(deleteNote).toHaveBeenCalledTimes(1);
  expect(deleteNote).toHaveBeenCalledWith('remote-first');
});

it('shares concurrent immediate and background DELETE requests', async () => {
  const note = privateNote();
  let finish: () => void = () => {};
  jest.mocked(deleteNote).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const immediate = deletePrivateNoteCloudCopy(note);
  const background = pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([immediate, background]);
});

it('uses each caller checkpoint independently when sharing a DELETE', async () => {
  const note = privateNote();
  let finish: () => void = () => {};
  let cancelled = false;
  jest.mocked(deleteNote).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = deletePrivateNoteCloudCopy(note, () => {
    if (cancelled) throw new SyncCancelledError();
  });
  const firstResult = first.catch((error: unknown): unknown => error);
  const second = deletePrivateNoteCloudCopy(note);
  cancelled = true;
  finish();
  expect(await firstResult).toBeInstanceOf(SyncCancelledError);
  await second;
  expect(deleteNote).toHaveBeenCalledTimes(1);
  expect(mockRepo.getNoteById(note.id)!.remoteId).toBeNull();
});

it('does not join a previous account session request', async () => {
  const note = privateNote();
  const finishes: Array<() => void> = [];
  jest.mocked(deleteNote).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
  );
  const first = deletePrivateNoteCloudCopy(note);
  mockAuth.user = { id: 'account-b' };
  mockAuth.sessionCookie = 'cookie-b';
  const second = deletePrivateNoteCloudCopy(note);
  expect(deleteNote).toHaveBeenCalledTimes(2);
  finishes.forEach((finish) => finish());
  await Promise.all([first, second]);
});

it('does not clear local or queued identities after an account-switch cancellation', async () => {
  const note = privateNote();
  queuePrivateNoteDeletion(note);
  let cancelled = false;
  jest.mocked(deleteNote).mockImplementationOnce(async () => {
    cancelled = true;
  });
  await expect(
    pushPrivateNoteDeletes(() => {
      if (cancelled) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockRepo.getNoteById(note.id)!.remoteId).toBe('remote');
  mockRepo.setNotePrivacy(note.id, false);
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledTimes(2);
});

it('clears retired identities explicitly during an account link', async () => {
  const note = privateNote();
  queuePrivateNoteDeletion(note);
  mockRepo.setNotePrivacy(note.id, false);
  clearPrivateNoteDeletionQueue();
  await pushPrivateNoteDeletes();
  expect(deleteNote).not.toHaveBeenCalled();
  expect(fetchNotes).not.toHaveBeenCalled();
});

it('continues unrelated cleanup after one deletion fails', async () => {
  const first = privateNote('-first');
  const second = privateNote('-second');
  jest
    .mocked(deleteNote)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(undefined);
  await expect(pushPrivateNoteDeletes()).rejects.toThrow('offline');
  expect(mockRepo.getNoteById(first.id)!.remoteId).toBe('remote-first');
  expect(mockRepo.getNoteById(second.id)!.remoteId).toBeNull();
});

it('ignores a stale private snapshot once its confirmed cleanup already detached the identity', async () => {
  const note = privateNote();
  jest.mocked(deleteNote).mockResolvedValue(undefined);
  await deletePrivateNoteCloudCopy(note);
  jest.mocked(deleteNote).mockRejectedValue({ status: 404 });
  await deletePrivateNoteCloudCopy(note);
  expect(deleteNote).toHaveBeenCalledTimes(1);
  expect(fetchNotes).not.toHaveBeenCalled();
});

it('persists only cloud identifiers in retired cleanup state', () => {
  const note = privateNote();
  queuePrivateNoteDeletion(note);
  const saved = mockRepo.getSyncState('notes.private_deletion_queue');
  expect(JSON.parse(saved!)).toEqual([{ remoteId: 'remote', clientNoteId: 'client' }]);
});

it('settles an identity queued while its immediate DELETE was in flight without touching publication', async () => {
  const note = privateNote();
  let finish: () => void = () => {};
  jest.mocked(deleteNote).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const immediate = deletePrivateNoteCloudCopy(note);
  queuePrivateNoteDeletion(note);
  mockRepo.clearNoteRemoteId(note.id);
  mockRepo.setNotePrivacy(note.id, false);
  mockRepo.setNoteClientId(note.id, 'new-client');
  finish();
  await immediate;
  await pushPrivateNoteDeletes();
  expect(deleteNote).toHaveBeenCalledTimes(1);
  expect(mockRepo.getNoteById(note.id)).toMatchObject({
    clientNoteId: 'new-client',
    remoteId: null,
    isPrivate: 0,
  });
});

it('ignores a late failure after another caller has confirmed the same deletion', async () => {
  const note = privateNote('', false);
  let finishLookup: (result: { notes: RemoteNote[] }) => void = () => {};
  jest.mocked(fetchNotes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
  );
  const recovery = deletePrivateNoteCloudCopy(note);
  mockRepo.markNotePushed(note, 'remote', 'server-time');
  jest.mocked(deleteNote).mockResolvedValueOnce(undefined).mockRejectedValueOnce({ status: 404 });
  await deletePrivateNoteCloudCopy(mockRepo.getNoteById(note.id)!);
  finishLookup({ notes: [remoteNote()] });
  await recovery;
  expect(mockRepo.getNoteById(note.id)).toMatchObject({ remoteId: null, clientNoteId: null });
});
