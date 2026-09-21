// pushDictionary.ts talks to drizzle directly (not through notesRepository).
// A minimal fluent chain stands in for `db` so tests never touch SQLite;
// `select().from().where().all()` returns the configured pending rows and
// `update()/delete()/insert()` are tracked call counts — cheap since (unlike
// pushNotes.ts) this file's mutation helpers (markPushed/markTerminal/
// clearRemoteId/hardDelete) don't need per-call assertions here, only "did
// any DB mutation happen at all" for the policy-blocked guard.
function createChain(result: unknown) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.set = jest.fn(() => chain);
  chain.values = jest.fn(() => chain);
  chain.all = jest.fn(() => result);
  chain.get = jest.fn(() => result);
  chain.run = jest.fn(() => result);
  return chain;
}

let pendingRows: unknown[] = [];
const mockDb = {
  select: jest.fn(() => createChain(pendingRows)),
  update: jest.fn(() => createChain(undefined)),
  delete: jest.fn(() => createChain(undefined)),
  insert: jest.fn(() => createChain(undefined)),
};

// jest.mock is hoisted above `const mockDb` above, so the factory can't
// close over it directly (it would read `mockDb` before initialization). A
// getter defers the read to each call site (`db.select()` etc. inside
// pushDictionary.ts), by which point `mockDb` is fully assigned.
jest.mock('@/db', () => ({
  get db() {
    return mockDb;
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
import {
  batchCreateDictionary,
  updateDictionaryEntry,
  deleteDictionaryEntry,
} from '@/data/remote/dictionaryApi';
import * as Sentry from '@sentry/react-native';

const mockBatchCreate = batchCreateDictionary as jest.Mock;
const mockUpdate = updateDictionaryEntry as jest.Mock;
const mockDelete = deleteDictionaryEntry as jest.Mock;
const mockCaptureException = Sentry.captureException as jest.Mock;

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  word: 'openwhispr',
  source: 'manual' as const,
  clientDictId: 'client-dict-1',
  remoteId: null,
  deletedAt: null,
  pendingSync: 1,
  createdAt: '2026-08-24T09:00:00.000Z',
  updatedAt: '2026-08-24T09:00:00.000Z',
  ...overrides,
});

const policyError = { status: 403, code: 'POLICY_CLOUD_BACKUP_BLOCKED', message: 'blocked' };

beforeEach(() => {
  jest.clearAllMocks();
  pendingRows = [];
});

describe('pushDictionary POLICY_CLOUD_BACKUP_BLOCKED propagation', () => {
  it('rethrows a create 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [entry({ id: 1, remoteId: null })];
    mockBatchCreate.mockRejectedValue(policyError);

    await expect(pushDictionary()).rejects.toMatchObject({
      status: 403,
      code: 'POLICY_CLOUD_BACKUP_BLOCKED',
    });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows an update 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [entry({ id: 1, remoteId: 'remote-dict-1' })];
    mockUpdate.mockRejectedValue(policyError);

    await expect(pushDictionary()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows a delete 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [
      entry({ id: 1, remoteId: 'remote-dict-1', deletedAt: '2026-08-24T09:30:00.000Z' }),
    ];
    mockDelete.mockRejectedValue(policyError);

    await expect(pushDictionary()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a blocked create stops the run before any update runs', async () => {
    pendingRows = [
      entry({ id: 1, remoteId: null, clientDictId: 'client-dict-1' }),
      entry({ id: 2, remoteId: 'remote-dict-2' }),
    ];
    mockBatchCreate.mockRejectedValue(policyError);

    await expect(pushDictionary()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('an ordinary terminal error (400) still marks terminal as before (guard does not change existing semantics)', async () => {
    pendingRows = [entry({ id: 1, remoteId: null })];
    mockBatchCreate.mockRejectedValue({ status: 400, message: 'Payload rejected' });

    await expect(pushDictionary()).resolves.toBeUndefined();

    expect(mockDb.update).toHaveBeenCalled();
  });
});
