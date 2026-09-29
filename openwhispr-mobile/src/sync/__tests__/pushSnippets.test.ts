// pushSnippets.ts talks to drizzle directly (not through notesRepository).
// See pushDictionary.test.ts for why a minimal fluent chain stands in for
// `db` here instead of a full mock.
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
// pushSnippets.ts), by which point `mockDb` is fully assigned.
jest.mock('@/db', () => ({
  get db() {
    return mockDb;
  },
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock('@/data/remote/snippetsApi', () => ({
  batchCreateSnippets: jest.fn(),
  updateSnippet: jest.fn(),
  deleteSnippet: jest.fn(),
}));

import { pushSnippets } from '../pushSnippets';
import { SyncCancelledError } from '../syncContext';
import { batchCreateSnippets, updateSnippet, deleteSnippet } from '@/data/remote/snippetsApi';
import * as Sentry from '@sentry/react-native';

const mockBatchCreate = batchCreateSnippets as jest.Mock;
const mockUpdate = updateSnippet as jest.Mock;
const mockDelete = deleteSnippet as jest.Mock;
const mockCaptureException = Sentry.captureException as jest.Mock;

const snippet = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  trigger: ';ow',
  replacement: 'OpenWhispr',
  clientSnippetId: 'client-snippet-1',
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

it('stops subsequent snippet updates after backup is disabled', async () => {
  pendingRows = [
    snippet({ id: 1, remoteId: 'remote-1' }),
    snippet({ id: 2, remoteId: 'remote-2' }),
  ];
  let disabled = false;
  mockUpdate.mockImplementation(async (id: string) => {
    disabled = true;
    return { id, updated_at: '2026-09-17T12:00:00.000Z' };
  });
  await expect(
    pushSnippets((upload) => {
      if (upload && disabled) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockUpdate).toHaveBeenCalledTimes(1);
});

it('does not acknowledge a snippet update after identity changes', async () => {
  pendingRows = [snippet({ id: 1, remoteId: 'remote-1' })];
  let switched = false;
  mockUpdate.mockImplementation(async (id: string) => {
    switched = true;
    return { id, updated_at: '2026-09-17T12:00:00.000Z' };
  });
  await expect(
    pushSnippets(() => {
      if (switched) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockDb.update).not.toHaveBeenCalled();
});

describe('pushSnippets POLICY_CLOUD_BACKUP_BLOCKED propagation', () => {
  it('rethrows a create 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [snippet({ id: 1, remoteId: null })];
    mockBatchCreate.mockRejectedValue(policyError);

    await expect(pushSnippets()).rejects.toMatchObject({
      status: 403,
      code: 'POLICY_CLOUD_BACKUP_BLOCKED',
    });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows an update 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [snippet({ id: 1, remoteId: 'remote-snippet-1' })];
    mockUpdate.mockRejectedValue(policyError);

    await expect(pushSnippets()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows a delete 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, mutating nothing', async () => {
    pendingRows = [
      snippet({ id: 1, remoteId: 'remote-snippet-1', deletedAt: '2026-08-24T09:30:00.000Z' }),
    ];
    mockDelete.mockRejectedValue(policyError);

    await expect(pushSnippets()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a blocked create stops the run before any update runs', async () => {
    pendingRows = [
      snippet({ id: 1, remoteId: null, clientSnippetId: 'client-snippet-1' }),
      snippet({ id: 2, remoteId: 'remote-snippet-2' }),
    ];
    mockBatchCreate.mockRejectedValue(policyError);

    await expect(pushSnippets()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('an ordinary terminal error (400) still marks terminal as before (guard does not change existing semantics)', async () => {
    pendingRows = [snippet({ id: 1, remoteId: null })];
    mockBatchCreate.mockRejectedValue({ status: 400, message: 'Payload rejected' });

    await expect(pushSnippets()).resolves.toBeUndefined();

    expect(mockDb.update).toHaveBeenCalled();
  });
});
