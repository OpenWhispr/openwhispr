import type { Note } from '@/data';

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({
    user: { id: 'owner', isAnonymous: false },
    sessionCookie: 'session',
    isGuest: false,
    isLoading: false,
  })),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: require('zustand').create(() => ({ notes: [] })),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: { cloudBackupEnabled: true } })),
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: jest.fn(),
    hasDirtyTranscript: jest.fn(),
    isRemoteNoteHeldByFolderDelete: jest.fn(),
    getSyncState: jest.fn(),
  },
  spacesRepository: { listSpaces: jest.fn(() => []) },
}));
const mockListeners = new Set<(hasQueuedRun: boolean) => void>();
jest.mock('../syncEngine', () => ({
  requestSync: jest.fn(),
  subscribeSyncCompletion: (callback: (hasQueuedRun: boolean) => void): (() => void) => {
    mockListeners.add(callback);
    return () => {
      mockListeners.delete(callback);
    };
  },
}));
import { notesRepository, spacesRepository } from '@/data';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useConfigStore } from '@/store/useConfigStore';
import { requestSync } from '../syncEngine';
import { useSyncStore } from '../useSyncStore';
import { ensureNoteSynced } from '../ensureNoteSynced';

let note: Note;
let controller: AbortController;
const complete = (hasQueuedRun = false): void => {
  for (const listener of mockListeners) listener(hasQueuedRun);
};
beforeEach((): void => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(notesRepository.getSyncState).mockReturnValue(null);
  note = {
    id: 1,
    clientNoteId: 'client',
    remoteId: null,
    isPrivate: 0,
    pendingSync: 1,
    deletedAt: null,
    conflictServerNote: null,
    spaceId: null,
  } as Note;
  controller = new AbortController();
  jest.mocked(notesRepository.getNoteById).mockImplementation(() => note);
  jest.mocked(notesRepository.hasDirtyTranscript).mockReturnValue(false);
  jest.mocked(notesRepository.isRemoteNoteHeldByFolderDelete).mockReturnValue(false);
  jest.mocked(spacesRepository.listSpaces).mockReturnValue([]);
  useAuthStore.setState({
    user: { id: 'owner', isAnonymous: false } as NonNullable<
      ReturnType<typeof useAuthStore.getState>['user']
    >,
    sessionCookie: 'session',
    isGuest: false,
    isLoading: false,
  });
  useConfigStore.setState({
    config: { cloudBackupEnabled: true } as NonNullable<
      ReturnType<typeof useConfigStore.getState>['config']
    >,
  });
  useSyncStore
    .getState()
    .set({ status: 'idle', lastError: null, policyBlocked: false, subscriptionRequired: false });
});
afterEach((): void => {
  controller.abort();
  jest.useRealTimers();
});

it('waits for an acknowledged current revision, including edits during a pass', async (): Promise<void> => {
  const settled = jest.fn();
  const pending = ensureNoteSynced(1, { signal: controller.signal }).then(settled);
  expect(requestSync).toHaveBeenCalledWith('manual');
  note = { ...note, remoteId: 'remote', pendingSync: 1 };
  complete();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  note = { ...note, pendingSync: 0 };
  complete();
  await pending;
  expect(settled).toHaveBeenCalledWith('remote');
  expect(mockListeners.size).toBe(0);
});
it('does not resolve an existing remote ID with dirty transcript data', async (): Promise<void> => {
  note = { ...note, remoteId: 'remote', pendingSync: 0 };
  jest.mocked(notesRepository.hasDirtyTranscript).mockReturnValue(true);
  const settled = jest.fn();
  const pending = ensureNoteSynced(1, { signal: controller.signal }).then(settled);
  complete();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  jest.mocked(notesRepository.hasDirtyTranscript).mockReturnValue(false);
  complete();
  await pending;
  expect(settled).toHaveBeenCalledWith('remote');
});
it.each([
  ['private', { isPrivate: 1 }, /cloud sync/i],
  ['deleted', { deletedAt: 'now' }, /available/i],
  ['conflicted', { conflictServerNote: '{}' }, /conflict/i],
])('rejects a %s note before publishing', async (_label, patch, message): Promise<void> => {
  note = { ...note, ...patch };
  await expect(ensureNoteSynced(1, { signal: controller.signal })).rejects.toThrow(message);
  expect(requestSync).not.toHaveBeenCalled();
});
it('rejects a note held by a folder deletion', async (): Promise<void> => {
  jest.mocked(notesRepository.isRemoteNoteHeldByFolderDelete).mockReturnValue(true);
  await expect(ensureNoteSynced(1, { signal: controller.signal })).rejects.toThrow(/available/i);
});
it('rejects anonymous sessions', async (): Promise<void> => {
  useAuthStore.setState({
    user: { id: 'owner', isAnonymous: true } as NonNullable<
      ReturnType<typeof useAuthStore.getState>['user']
    >,
  });
  await expect(ensureNoteSynced(1, { signal: controller.signal })).rejects.toThrow(/account/i);
});
it('aborts if the session changes while sync is running', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  useAuthStore.setState({ sessionCookie: 'replacement' });
  await expect(pending).rejects.toThrow(/changed/i);
  expect(mockListeners.size).toBe(0);
});
it('aborts if the note becomes private while waiting', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  note = { ...note, isPrivate: 1 };
  useNotesStore.setState({ notes: [note] });
  await expect(pending).rejects.toThrow(/cloud sync/i);
});
it('does not adopt a republished note identity', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  note = { ...note, clientNoteId: 'new-client', remoteId: 'new-remote', pendingSync: 0 };
  complete();
  await expect(pending).rejects.toThrow(/changed/i);
});
it('surfaces a subscription gate for personal notes', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  useSyncStore.getState().set({ subscriptionRequired: true });
  complete();
  await expect(pending).rejects.toThrow(/subscription/i);
});
it('does not apply the personal subscription gate to a synced team note', async (): Promise<void> => {
  note = { ...note, spaceId: 2 };
  jest
    .mocked(spacesRepository.listSpaces)
    .mockReturnValue([
      { id: 2, kind: 'team' } as ReturnType<typeof spacesRepository.listSpaces>[number],
    ]);
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  useSyncStore.getState().set({ subscriptionRequired: true });
  note = { ...note, remoteId: 'team-note', pendingSync: 0 };
  complete();
  await expect(pending).resolves.toBe('team-note');
});
it('rejects after a bounded offline wait and unsubscribes', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal, timeoutMs: 30 });
  jest.advanceTimersByTime(30);
  await expect(pending).rejects.toThrow(/sync.*try again/i);
  expect(mockListeners.size).toBe(0);
});
it('cancels without stopping background sync', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow(/cancel/i);
  expect(mockListeners.size).toBe(0);
});

it('rejects terminally dropped edits instead of sharing stale cloud content', async (): Promise<void> => {
  note = { ...note, remoteId: 'remote' };
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  note = { ...note, pendingSync: 0 };
  jest.mocked(notesRepository.getSyncState).mockReturnValue('1');
  complete();
  await expect(pending).rejects.toThrow(/rejected/i);
});
it('waits for the queued manual pass before using an earlier pass’s gate', async (): Promise<void> => {
  const pending = ensureNoteSynced(1, { signal: controller.signal });
  useSyncStore.getState().set({ subscriptionRequired: true });
  complete(true);
  useSyncStore.getState().set({ subscriptionRequired: false });
  note = { ...note, remoteId: 'remote', pendingSync: 0 };
  complete();
  await expect(pending).resolves.toBe('remote');
});

it('waits for the actual content base to reach a sharing metadata revision', async (): Promise<void> => {
  note = { ...note, remoteId: 'remote', pendingSync: 0, cloudUpdatedAt: '2026-09-22T12:00:00Z' };
  const settled = jest.fn();
  const pending = ensureNoteSynced(1, {
    signal: controller.signal,
    minCloudUpdatedAt: '2026-09-22T12:00:01Z',
  }).then(settled);
  complete();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  note = { ...note, cloudUpdatedAt: '2026-09-22T12:00:01Z' };
  complete();
  await pending;
  expect(settled).toHaveBeenCalledWith('remote');
});
