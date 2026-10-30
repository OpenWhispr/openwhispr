import { eq } from 'drizzle-orm';
import { dictionaryEntries } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { TestDb } from '@/data/local/__tests__/testDb';

let mockRepo: LocalNotesRepository;
let mockDatabase: TestDb;
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
}));
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('@/data/remote/dictionaryApi', () => ({
  fetchDictionary: jest.fn(),
  fetchDictionarySnapshot: jest.fn(),
  batchCreateDictionary: jest.fn(),
  updateDictionaryEntry: jest.fn(),
  deleteDictionaryEntry: jest.fn(),
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { pullDictionary } from '../pullDictionary';
import { pushDictionary } from '../pushDictionary';
import {
  batchCreateDictionary,
  fetchDictionary,
  fetchDictionarySnapshot,
  updateDictionaryEntry,
} from '@/data/remote/dictionaryApi';
import type { RemoteDictionaryEntry } from '@/data/remote/dictionaryApi';
import * as Sentry from '@sentry/react-native';
import {
  DICTIONARY_CURSOR_ID_KEY,
  DICTIONARY_CURSOR_KEY,
  DICTIONARY_SHARED_AT_BACKFILL_KEY,
} from '../pullCursors';

const SHARED_AT = '2026-10-20T09:00:00.000Z';

const remoteEntry = (overrides: Partial<RemoteDictionaryEntry> = {}): RemoteDictionaryEntry => ({
  id: 'remote-1',
  client_dict_id: 'client-1',
  word: 'Kubernetes',
  source: 'manual',
  deleted_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
  shared_at: null,
  ...overrides,
});

const insertLocal = (overrides: Partial<typeof dictionaryEntries.$inferInsert> = {}): void => {
  mockDatabase
    .insert(dictionaryEntries)
    .values({
      word: 'Kubernetes',
      source: 'manual',
      clientDictId: 'client-1',
      remoteId: 'remote-1',
      pendingSync: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      ...overrides,
    })
    .run();
};

const readRow = (): typeof dictionaryEntries.$inferSelect | undefined =>
  mockDatabase
    .select()
    .from(dictionaryEntries)
    .where(eq(dictionaryEntries.word, 'Kubernetes'))
    .get();

beforeEach(() => {
  jest.resetAllMocks();
  const memory = createMemoryRepository();
  mockRepo = memory.repo;
  mockDatabase = memory.db;
  jest.mocked(fetchDictionarySnapshot).mockResolvedValue({ entries: [], hasMore: false });
  jest.mocked(fetchDictionary).mockResolvedValue({ entries: [], hasMore: false });
  // Most tests start past the one-time backfill so the cursor stays put.
  mockRepo.setSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY, '1');
});

describe('pullDictionary shared_at', () => {
  it('stores shared_at on an existing row', async () => {
    insertLocal();
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()?.sharedAt).toBe(SHARED_AT);
  });

  it('stores shared_at on insert', async () => {
    jest
      .mocked(fetchDictionarySnapshot)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()?.sharedAt).toBe(SHARED_AT);
  });

  it('applies an update that changes only shared_at (same updated_at)', async () => {
    insertLocal({ sharedAt: null });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()).toMatchObject({ sharedAt: SHARED_AT, updatedAt: '2026-10-02T00:00:00.000Z' });
  });

  it('clears shared_at when the payload sends an explicit null', async () => {
    insertLocal({ sharedAt: SHARED_AT });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: null })], hasMore: false });

    await pullDictionary();

    expect(readRow()?.sharedAt).toBeNull();
  });

  it('keeps the local shared_at when an older API omits the field', async () => {
    insertLocal({ sharedAt: SHARED_AT });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    const legacy: Partial<RemoteDictionaryEntry> = remoteEntry();
    delete legacy.shared_at;
    jest.mocked(fetchDictionary).mockResolvedValueOnce({
      entries: [legacy as RemoteDictionaryEntry],
      hasMore: false,
    });

    await pullDictionary();

    expect(readRow()?.sharedAt).toBe(SHARED_AT);
  });

  it('a pending local create keeps its own (null) marker', async () => {
    insertLocal({ pendingSync: 1, remoteId: null, sharedAt: null });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()).toMatchObject({ sharedAt: null, pendingSync: 1 });
  });

  it('a clear still to be pushed is not undone by the server copy', async () => {
    insertLocal({ pendingSync: 1, sharedAt: null, sharedAtCleared: 1 });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()).toMatchObject({ sharedAt: null, sharedAtCleared: 1, pendingSync: 1 });
  });

  it('still records shared_at on a row with a pending local edit', async () => {
    insertLocal({ pendingSync: 1, word: 'Kubernetes' });
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest.mocked(fetchDictionary).mockResolvedValueOnce({
      entries: [remoteEntry({ word: 'Kubernetes', shared_at: SHARED_AT })],
      hasMore: false,
    });

    await pullDictionary();

    expect(readRow()).toMatchObject({ sharedAt: SHARED_AT, pendingSync: 1 });
  });
});

describe('pullDictionary tombstones', () => {
  const RETIRED_AT = '2026-10-03T00:00:00.000Z';
  const retired = (): RemoteDictionaryEntry =>
    remoteEntry({ deleted_at: RETIRED_AT, updated_at: RETIRED_AT, shared_at: SHARED_AT });

  beforeEach(() => {
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
  });

  it('a take-back the server retired before its push is kept and pushed as a create', async () => {
    // applyAddOne's take-back: shared_at cleared locally, remoteId kept.
    insertLocal({ pendingSync: 1, sharedAt: null, sharedAtCleared: 1 });
    jest.mocked(fetchDictionary).mockResolvedValueOnce({ entries: [retired()], hasMore: false });

    await pullDictionary();

    expect(readRow()).toMatchObject({
      remoteId: null,
      deletedAt: null,
      sharedAt: null,
      sharedAtCleared: 1,
      pendingSync: 1,
    });

    jest
      .mocked(batchCreateDictionary)
      .mockResolvedValueOnce([
        { ...remoteEntry({ updated_at: '2026-10-04T00:00:00.000Z' }) },
      ] as never);
    await pushDictionary();

    expect(updateDictionaryEntry).not.toHaveBeenCalled();
    expect(batchCreateDictionary).toHaveBeenCalledWith([
      expect.objectContaining({ client_dict_id: 'client-1', word: 'Kubernetes', shared_at: null }),
    ]);
    expect(readRow()).toMatchObject({ remoteId: 'remote-1', sharedAtCleared: 0, pendingSync: 0 });
  });

  it('a pending edit that takes nothing back still follows the tombstone', async () => {
    insertLocal({ pendingSync: 1, sharedAtCleared: 0 });
    jest.mocked(fetchDictionary).mockResolvedValueOnce({ entries: [retired()], hasMore: false });

    await pullDictionary();

    expect(readRow()).toBeUndefined();
  });

  it('a take-back the user deleted again follows the tombstone', async () => {
    insertLocal({ pendingSync: 1, sharedAtCleared: 1, deletedAt: '2026-10-02T12:00:00.000Z' });
    jest.mocked(fetchDictionary).mockResolvedValueOnce({ entries: [retired()], hasMore: false });

    await pullDictionary();

    expect(readRow()).toBeUndefined();
  });
});

describe('pullDictionary shared_at backfill', () => {
  it('replays the snapshot once, then the delta from the stored cursor', async () => {
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    mockRepo.setSyncState(DICTIONARY_CURSOR_ID_KEY, 'remote-1');
    jest
      .mocked(fetchDictionarySnapshot)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(fetchDictionarySnapshot).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetchDictionary).mock.calls).toEqual([
      ['2026-10-02T00:00:00.000Z', 200, 'remote-1'],
    ]);
    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeTruthy();
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_KEY)).toBe('2026-10-02T00:00:00.000Z');

    await pullDictionary();

    // Later runs are a plain delta from the saved cursor.
    expect(fetchDictionarySnapshot).toHaveBeenCalledTimes(1);
    expect(fetchDictionary).toHaveBeenCalledTimes(2);
  });

  it('applies a deletion newer than the old cursor, which the live-only snapshot leaves out', async () => {
    insertLocal();
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest.mocked(fetchDictionary).mockResolvedValueOnce({
      entries: [
        remoteEntry({
          deleted_at: '2026-10-03T00:00:00.000Z',
          updated_at: '2026-10-03T00:00:00.000Z',
        }),
      ],
      hasMore: false,
    });

    await pullDictionary();

    expect(readRow()).toBeUndefined();
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_KEY)).toBe('2026-10-03T00:00:00.000Z');
  });

  it('an interrupted backfill keeps the old cursor and runs again', async () => {
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    jest.mocked(fetchDictionarySnapshot).mockResolvedValueOnce({
      entries: [remoteEntry({ updated_at: '2026-10-05T00:00:00.000Z', shared_at: SHARED_AT })],
      hasMore: false,
    });
    jest.mocked(fetchDictionary).mockRejectedValueOnce(new Error('offline'));

    await expect(pullDictionary()).rejects.toThrow('offline');

    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeNull();
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_KEY)).toBe('2026-10-02T00:00:00.000Z');

    await pullDictionary();

    expect(fetchDictionarySnapshot).toHaveBeenCalledTimes(2);
    expect(jest.mocked(fetchDictionary).mock.calls[1][0]).toBe('2026-10-02T00:00:00.000Z');
    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeTruthy();
  });

  it('a first sync is just the snapshot', async () => {
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    jest
      .mocked(fetchDictionarySnapshot)
      .mockResolvedValueOnce({ entries: [remoteEntry()], hasMore: false });

    await pullDictionary();

    expect(fetchDictionary).not.toHaveBeenCalled();
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_KEY)).toBe('2026-10-02T00:00:00.000Z');
    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeTruthy();
  });

  it('refreshes shared_at on a row a cursor had already passed', async () => {
    insertLocal();
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-05T00:00:00.000Z');
    jest
      .mocked(fetchDictionarySnapshot)
      .mockResolvedValueOnce({ entries: [remoteEntry({ shared_at: SHARED_AT })], hasMore: false });

    await pullDictionary();

    expect(readRow()?.sharedAt).toBe(SHARED_AT);
  });

  it('keeps the cursor and runs a delta when the backfill already happened', async () => {
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-05T00:00:00.000Z');

    await pullDictionary();

    expect(fetchDictionarySnapshot).not.toHaveBeenCalled();
    expect(jest.mocked(fetchDictionary).mock.calls[0][0]).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('pullDictionary stalled pages', () => {
  it('ends a delta that stopped advancing and keeps what it applied', async () => {
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-01T00:00:00.000Z');
    mockRepo.setSyncState(DICTIONARY_CURSOR_ID_KEY, 'remote-0');
    const stuck = remoteEntry({ shared_at: SHARED_AT });
    jest
      .mocked(fetchDictionary)
      .mockResolvedValueOnce({ entries: [stuck], hasMore: true })
      .mockResolvedValueOnce({ entries: [stuck], hasMore: true });

    await expect(pullDictionary()).resolves.toBeUndefined();

    expect(fetchDictionary).toHaveBeenCalledTimes(2);
    expect(readRow()?.sharedAt).toBe(SHARED_AT);
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_KEY)).toBe('2026-10-02T00:00:00.000Z');
    expect(mockRepo.getSyncState(DICTIONARY_CURSOR_ID_KEY)).toBe('remote-1');
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning', category: 'sync' }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a backfill whose snapshot stopped advancing is not marked done, so it runs again', async () => {
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    const stuck = remoteEntry({ shared_at: SHARED_AT });
    jest
      .mocked(fetchDictionarySnapshot)
      .mockResolvedValueOnce({ entries: [stuck], hasMore: true })
      .mockResolvedValueOnce({ entries: [stuck], hasMore: true });

    await expect(pullDictionary()).resolves.toBeUndefined();

    // The delta from the stored cursor still runs.
    expect(fetchDictionary).toHaveBeenCalledTimes(1);
    expect(readRow()?.sharedAt).toBe(SHARED_AT);
    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeNull();

    await pullDictionary();

    expect(fetchDictionarySnapshot).toHaveBeenCalledTimes(3);
    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeTruthy();
  });

  it('a backfill whose delta stopped advancing is not marked done', async () => {
    mockRepo.clearSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY);
    mockRepo.setSyncState(DICTIONARY_CURSOR_KEY, '2026-10-02T00:00:00.000Z');
    mockRepo.setSyncState(DICTIONARY_CURSOR_ID_KEY, 'remote-1');
    const stuck = remoteEntry();
    jest.mocked(fetchDictionary).mockResolvedValueOnce({ entries: [stuck], hasMore: true });

    await pullDictionary();

    expect(mockRepo.getSyncState(DICTIONARY_SHARED_AT_BACKFILL_KEY)).toBeNull();
  });
});
