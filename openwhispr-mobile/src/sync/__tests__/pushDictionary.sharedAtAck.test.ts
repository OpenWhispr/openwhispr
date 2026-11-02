/**
 * The take-back flag (shared_at_cleared) against a real SQLite table: only the
 * acknowledgement of the exact row that was sent may reset it.
 */
import { eq } from 'drizzle-orm';
import { dictionaryEntries } from '@/db/schema';
import { createMemoryRepository, type TestDb } from '@/data/local/__tests__/testDb';

let mockDatabase: TestDb;
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock('@/data/remote/dictionaryApi', () => ({
  batchCreateDictionary: jest.fn(),
  updateDictionaryEntry: jest.fn(),
  deleteDictionaryEntry: jest.fn(),
}));

import { pushDictionary } from '../pushDictionary';
import { updateDictionaryEntry } from '@/data/remote/dictionaryApi';

const UPDATED_AT = '2026-10-21 09:00:00';
const SERVER_UPDATED_AT = '2026-10-21T09:00:01.000Z';

const insertRow = (overrides: Partial<typeof dictionaryEntries.$inferInsert> = {}): void => {
  mockDatabase
    .insert(dictionaryEntries)
    .values({
      word: 'Grafana',
      source: 'manual',
      clientDictId: 'client-1',
      remoteId: 'remote-1',
      sharedAt: null,
      sharedAtCleared: 1,
      pendingSync: 1,
      updatedAt: UPDATED_AT,
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
  jest.clearAllMocks();
  mockDatabase = createMemoryRepository().db;
});

it('an acknowledged clear stops being resent', async () => {
  insertRow();
  jest
    .mocked(updateDictionaryEntry)
    .mockResolvedValue({ id: 'remote-1', updated_at: SERVER_UPDATED_AT } as never);

  await pushDictionary();

  expect(updateDictionaryEntry).toHaveBeenCalledWith('remote-1', {
    word: 'Grafana',
    source: 'manual',
    shared_at: null,
  });
  expect(readRow()).toMatchObject({
    sharedAtCleared: 0,
    pendingSync: 0,
    updatedAt: SERVER_UPDATED_AT,
  });
});

it('a take-back made in the same second as an in-flight push survives its ack', async () => {
  insertRow({ sharedAt: '2026-10-20T09:00:00.000Z', sharedAtCleared: 0 });
  jest.mocked(updateDictionaryEntry).mockImplementation(async () => {
    // The user re-adds the moved word while the request is out; datetime('now')
    // lands on the same second, so updated_at alone can't tell the rows apart.
    mockDatabase
      .update(dictionaryEntries)
      .set({ sharedAt: null, sharedAtCleared: 1, pendingSync: 1, updatedAt: UPDATED_AT })
      .where(eq(dictionaryEntries.clientDictId, 'client-1'))
      .run();
    return { id: 'remote-1', updated_at: SERVER_UPDATED_AT } as never;
  });

  await pushDictionary();

  expect(readRow()).toMatchObject({ sharedAt: null, sharedAtCleared: 1, pendingSync: 1 });
});

it('a failed push keeps the clear queued', async () => {
  insertRow();
  jest.mocked(updateDictionaryEntry).mockRejectedValue({ status: 500, message: 'down' });

  await expect(pushDictionary()).rejects.toThrow('1 operation(s) failed');

  expect(readRow()).toMatchObject({ sharedAtCleared: 1, pendingSync: 1 });
});
