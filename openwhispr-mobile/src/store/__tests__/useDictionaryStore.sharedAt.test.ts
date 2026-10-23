import { eq } from 'drizzle-orm';
import { dictionaryEntries } from '@/db/schema';
import { createMemoryRepository, type TestDb } from '@/data/local/__tests__/testDb';

let mockDatabase: TestDb;
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));

import { useDictionaryStore } from '../useDictionaryStore';

const SHARED_AT = '2026-10-20T09:00:00.000Z';

const insertRow = (overrides: Partial<typeof dictionaryEntries.$inferInsert> = {}): void => {
  mockDatabase
    .insert(dictionaryEntries)
    .values({
      word: 'Grafana',
      source: 'manual',
      clientDictId: 'client-1',
      remoteId: 'remote-1',
      sharedAt: SHARED_AT,
      pendingSync: 0,
      ...overrides,
    })
    .run();
};

const readRow = (): typeof dictionaryEntries.$inferSelect | undefined =>
  mockDatabase
    .select()
    .from(dictionaryEntries)
    .where(eq(dictionaryEntries.clientDictId, 'client-1'))
    .get();

beforeEach(() => {
  mockDatabase = createMemoryRepository().db;
  useDictionaryStore.getState().reset();
});

describe('taking a moved word back', () => {
  it('an explicit re-add clears shared_at and queues the clear', async () => {
    insertRow();

    useDictionaryStore.getState().addWords('Grafana');

    expect(readRow()).toMatchObject({ sharedAt: null, sharedAtCleared: 1, pendingSync: 1 });
    expect(useDictionaryStore.getState().entries).toEqual([
      expect.objectContaining({ word: 'Grafana', sharedAt: null }),
    ]);
  });

  it('a learned word never takes a moved word back', () => {
    insertRow();

    useDictionaryStore.getState().addLearnedWords(['Grafana']);

    expect(readRow()).toMatchObject({ sharedAt: SHARED_AT, sharedAtCleared: 0, pendingSync: 0 });
  });

  it('restoring a deleted moved word clears shared_at and queues the clear', () => {
    insertRow({ deletedAt: '2026-10-21 00:00:00', pendingSync: 1 });

    useDictionaryStore.getState().addWords('Grafana');

    expect(readRow()).toMatchObject({
      deletedAt: null,
      sharedAt: null,
      sharedAtCleared: 1,
      pendingSync: 1,
    });
  });

  // As desktop's restore does: a revived word is personal, whatever the server
  // last said about it, so the clear is always pushed.
  it('restoring any deleted word queues the clear', () => {
    insertRow({ deletedAt: '2026-10-21 00:00:00', pendingSync: 1, sharedAt: null });

    useDictionaryStore.getState().addLearnedWords(['Grafana']);

    expect(readRow()).toMatchObject({ deletedAt: null, sharedAt: null, sharedAtCleared: 1 });
  });

  it('re-adding a personal word that was never moved changes nothing', () => {
    insertRow({ sharedAt: null });

    useDictionaryStore.getState().addWords('Grafana');

    expect(readRow()).toMatchObject({ sharedAt: null, sharedAtCleared: 0, pendingSync: 0 });
  });
});
