const mockSyncState = new Map<string, string>();
const mockSyncStateWrites: string[] = [];
jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: (key: string): string | null => mockSyncState.get(key) ?? null,
    setSyncState: (key: string, value: string): void => {
      mockSyncStateWrites.push(key);
      mockSyncState.set(key, value);
    },
    clearSyncState: (key: string): void => {
      mockSyncState.delete(key);
    },
  },
}));

// apiClient pulls in expo/fetch, which jest-expo cannot instantiate.
jest.mock('@/lib/apiClient', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  },
}));

const mockFetchSharedDictionary = jest.fn();
const mockFetchSharedDictionaryHides = jest.fn();
jest.mock('@/data/remote/sharedDictionaryApi', () => ({
  fetchSharedDictionary: (...args: unknown[]) => mockFetchSharedDictionary(...args),
  fetchSharedDictionaryHides: (...args: unknown[]) => mockFetchSharedDictionaryHides(...args),
}));

const mockFetchMyWorkspaces = jest.fn();
jest.mock('@/data/remote/workspacesApi', () => ({
  fetchMyWorkspaces: (...args: unknown[]) => mockFetchMyWorkspaces(...args),
}));

const OWNER = 'user-1:cookie';
const mockUsageState: {
  usage: { entitlementSources?: { workspaceIds: string[] } } | null;
  ownerKey: string | null;
  load: jest.Mock;
} = { usage: null, ownerKey: OWNER, load: jest.fn() };
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => mockUsageState },
  getUsageOwnerKey: () => 'user-1:cookie',
}));

import { pullSharedDictionary } from '../pullSharedDictionary';
import {
  SHARED_DICTIONARY_CURSOR_ID_KEY,
  SHARED_DICTIONARY_CURSOR_KEY,
  SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
  SHARED_DICTIONARY_HIDES_CURSOR_KEY,
  resetAllPullCursors,
} from '../pullCursors';
import {
  loadSharedDictionaryState,
  saveSharedDictionaryState,
  SHARED_DICTIONARY_STATE_KEY,
  type SharedDictionaryState,
} from '../sharedDictionaryState';
import { ApiError } from '@/lib/apiClient';
import { SyncStalledError } from '../syncContext';
import type {
  RemoteSharedEntry,
  RemoteSharedHide,
  RemoteSharedScope,
} from '@/data/remote/sharedDictionaryApi';

const T0 = '2026-10-20T10:00:00.000Z';
const T0_MINUS_10S = '2026-10-20T09:59:50.000Z';
const T1 = '2026-10-20T11:00:00.000Z';
const T2 = '2026-10-20T11:00:05.000Z';
const H1 = '2026-10-20T11:00:01.000Z';

const scope = (spaceId: string | null): RemoteSharedScope => ({
  space_id: spaceId,
  name: spaceId ?? 'Workspace',
  member_count: 2,
  word_count: 1,
});

const entry = (
  id: string,
  word: string,
  overrides: Partial<RemoteSharedEntry> = {},
): RemoteSharedEntry => ({
  id,
  workspace_id: 'ws-1',
  space_id: null,
  word,
  created_at: `2026-10-0${id.slice(-1)}T00:00:00.000Z`,
  updated_at: `2026-10-1${id.slice(-1)}T00:00:00.000Z`,
  deleted_at: null,
  ...overrides,
});

const hide = (entryId: string, overrides: Partial<RemoteSharedHide> = {}): RemoteSharedHide => ({
  entry_id: entryId,
  workspace_id: 'ws-1',
  updated_at: `2026-10-1${entryId.slice(-1)}T01:00:00.000Z`,
  deleted_at: null,
  ...overrides,
});

const listPage = (
  entries: RemoteSharedEntry[],
  overrides: Partial<{
    hasMore: boolean;
    scopes: RemoteSharedScope[];
    paused: boolean;
    server_time: string;
  }> = {},
): object => ({
  entries,
  hasMore: false,
  scopes: [scope(null), scope('space-1')],
  paused: false,
  server_time: T1,
  ...overrides,
});

const hidesPage = (
  hides: RemoteSharedHide[],
  overrides: Partial<{ hasMore: boolean; server_time: string }> = {},
): object => ({ hides, hasMore: false, server_time: H1, ...overrides });

const STORED: SharedDictionaryState = {
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  entries: {
    e1: { spaceId: null, word: 'Acme' },
    e2: { spaceId: 'space-1', word: 'Gizmo' },
  },
  hiddenIds: [],
  scopes: [scope(null), scope('space-1')],
  paused: false,
};

async function seedStored(state: SharedDictionaryState = STORED): Promise<void> {
  await saveSharedDictionaryState(state);
  mockSyncState.set(SHARED_DICTIONARY_CURSOR_KEY, T0);
  mockSyncState.set(SHARED_DICTIONARY_HIDES_CURSOR_KEY, T0);
}

type ApiErrorClass = new (message: string, status: number, code?: string) => Error;

// An isolated module registry has its own ApiError class (loadIsolatedPull),
// which its tests pass in for instanceof to hold.
function apiError(status: number, code?: string, ErrorClass: unknown = ApiError): Error {
  return new (ErrorClass as ApiErrorClass)('failed', status, code);
}

// A fresh copy of the module, so the session flag a test sets stays out of the
// others. It comes with its own ApiError class.
function loadIsolatedPull(): { pull: typeof pullSharedDictionary; ApiError: unknown } {
  let isolated!: { pull: typeof pullSharedDictionary; ApiError: unknown };
  jest.isolateModules(() => {
    isolated = {
      pull: require('../pullSharedDictionary').pullSharedDictionary,
      ApiError: require('@/lib/apiClient').ApiError,
    };
  });
  return isolated;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSyncState.clear();
  mockSyncStateWrites.length = 0;
  mockUsageState.usage = null;
  mockUsageState.ownerKey = OWNER;
  mockUsageState.load.mockImplementation(async () => ({ usage: mockUsageState.usage }));
  mockFetchMyWorkspaces.mockResolvedValue({ data: [{ id: 'ws-1', name: 'Acme' }] });
  mockFetchSharedDictionary.mockResolvedValue(listPage([]));
  mockFetchSharedDictionaryHides.mockResolvedValue(hidesPage([]));
});

describe('pullSharedDictionary', () => {
  it('first pull pages the snapshot then stores delta cursors', async () => {
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([entry('e1', 'Acme')], { hasMore: true, server_time: T1 }))
      .mockResolvedValueOnce(
        listPage([entry('e2', 'Gizmo', { space_id: 'space-1' })], { server_time: T2 }),
      );
    mockFetchSharedDictionaryHides.mockResolvedValueOnce(hidesPage([hide('e2')]));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(1, 'ws-1', { limit: 200 });
    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(2, 'ws-1', {
      cursor: '2026-10-01T00:00:00.000Z',
      cursorId: 'e1',
      limit: 200,
    });
    expect(mockFetchSharedDictionaryHides).toHaveBeenCalledWith('ws-1', { limit: 200 });
    expect(await loadSharedDictionaryState()).toEqual({
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      entries: {
        e1: { spaceId: null, word: 'Acme' },
        e2: { spaceId: 'space-1', word: 'Gizmo' },
      },
      hiddenIds: ['e2'],
      scopes: [scope(null), scope('space-1')],
      paused: false,
    });
    // The FIRST page's server_time, so a row deleted behind page 2 is re-read.
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T1);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_ID_KEY)).toBe('e2');
    expect(mockSyncState.get(SHARED_DICTIONARY_HIDES_CURSOR_KEY)).toBe(H1);
    expect(mockSyncState.get(SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY)).toBe('e2');
  });

  it('pages the hides snapshot on the last hide', async () => {
    mockFetchSharedDictionary.mockResolvedValueOnce(listPage([entry('e1', 'Acme')]));
    mockFetchSharedDictionaryHides
      .mockResolvedValueOnce(hidesPage([hide('e1')], { hasMore: true }))
      .mockResolvedValueOnce(hidesPage([]));

    await pullSharedDictionary();

    expect(mockFetchSharedDictionaryHides).toHaveBeenNthCalledWith(2, 'ws-1', {
      cursor: '2026-10-11T01:00:00.000Z',
      cursorId: 'e1',
      limit: 200,
    });
    expect((await loadSharedDictionaryState())?.hiddenIds).toEqual(['e1']);
  });

  it('delta passes overlap the stored cursor by 10 seconds', async () => {
    await seedStored();
    mockFetchSharedDictionary.mockResolvedValueOnce(
      listPage([entry('e1', 'Acme')], { server_time: T1 }),
    );

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });

    expect(mockFetchSharedDictionary).toHaveBeenCalledTimes(1);
    expect(mockFetchSharedDictionary).toHaveBeenCalledWith('ws-1', {
      since: T0_MINUS_10S,
      limit: 200,
    });
    expect(mockFetchSharedDictionaryHides).toHaveBeenCalledWith('ws-1', {
      since: T0_MINUS_10S,
      limit: 200,
    });
    expect(await loadSharedDictionaryState()).toEqual(STORED);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T1);
  });

  it('later delta pages continue from the last row', async () => {
    await seedStored();
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([entry('e3', 'Widget')], { hasMore: true }))
      .mockResolvedValueOnce(listPage([entry('e1', 'Acme', { deleted_at: T1 })]));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(2, 'ws-1', {
      since: '2026-10-13T00:00:00.000Z',
      sinceId: 'e3',
      limit: 200,
    });
    expect((await loadSharedDictionaryState())?.entries).toEqual({
      e2: { spaceId: 'space-1', word: 'Gizmo' },
      e3: { spaceId: null, word: 'Widget' },
    });
  });

  it('applies hide and unhide deltas', async () => {
    await seedStored({ ...STORED, hiddenIds: ['e1'] });
    mockFetchSharedDictionaryHides.mockResolvedValueOnce(
      hidesPage([hide('e1', { deleted_at: T1 }), hide('e2')]),
    );

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect((await loadSharedDictionaryState())?.hiddenIds).toEqual(['e2']);
  });

  it('never moves a cursor backwards', async () => {
    await seedStored();
    mockFetchSharedDictionary.mockResolvedValueOnce(listPage([], { server_time: T0_MINUS_10S }));

    await pullSharedDictionary();

    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T0);
  });

  it('scopes prune words of a space the user left', async () => {
    await seedStored();
    mockFetchSharedDictionary.mockResolvedValueOnce(listPage([], { scopes: [scope(null)] }));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    const state = await loadSharedDictionaryState();
    expect(state?.entries).toEqual({ e1: { spaceId: null, word: 'Acme' } });
    expect(state?.scopes).toEqual([scope(null)]);
  });

  it('stores the paused flag from the last page', async () => {
    await seedStored();
    mockFetchSharedDictionary.mockResolvedValueOnce(listPage([], { paused: true }));

    await pullSharedDictionary();

    expect((await loadSharedDictionaryState())?.paused).toBe(true);
  });

  it('a returning scope triggers a fresh snapshot', async () => {
    await seedStored({ ...STORED, scopes: [scope(null)], entries: { e1: STORED.entries.e1 } });
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([], { scopes: [scope(null), scope('space-1')] }))
      .mockResolvedValueOnce(
        listPage([entry('e1', 'Acme'), entry('e2', 'Gizmo', { space_id: 'space-1' })], {
          server_time: T2,
        }),
      );

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(1, 'ws-1', {
      since: T0_MINUS_10S,
      limit: 200,
    });
    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(2, 'ws-1', { limit: 200 });
    // Hides are re-snapshotted alongside the entries.
    expect(mockFetchSharedDictionaryHides).toHaveBeenCalledWith('ws-1', { limit: 200 });
    expect((await loadSharedDictionaryState())?.entries).toEqual(STORED.entries);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T2);
  });

  it('a list joined mid-snapshot redoes the snapshot once for its older words', async () => {
    const workspaceOnly = { scopes: [scope(null)] };
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([entry('e1', 'Acme')], { ...workspaceOnly, hasMore: true }))
      // Joined space-1 here; its word e2 sorts before the page-2 cursor.
      .mockResolvedValueOnce(listPage([entry('e3', 'Widget')], { server_time: T2 }))
      .mockResolvedValueOnce(
        listPage([entry('e1', 'Acme'), entry('e2', 'Gizmo', { space_id: 'space-1' })], {
          hasMore: true,
          server_time: T2,
        }),
      )
      .mockResolvedValueOnce(listPage([entry('e3', 'Widget')], { server_time: T2 }));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenCalledTimes(4);
    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(3, 'ws-1', { limit: 200 });
    const state = await loadSharedDictionaryState();
    expect(state?.entries).toEqual({
      e1: { spaceId: null, word: 'Acme' },
      e2: { spaceId: 'space-1', word: 'Gizmo' },
      e3: { spaceId: null, word: 'Widget' },
    });
    expect(state?.scopes).toEqual([scope(null), scope('space-1')]);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T2);
  });

  it('a list joined during the redo too stores no cursor, so the next run snapshots', async () => {
    const joinMidPass = (): void => {
      mockFetchSharedDictionary
        .mockResolvedValueOnce(
          listPage([entry('e1', 'Acme')], { scopes: [scope(null)], hasMore: true }),
        )
        .mockResolvedValueOnce(listPage([entry('e3', 'Widget')]));
    };
    joinMidPass();
    joinMidPass();

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenCalledTimes(4);
    expect(Object.keys((await loadSharedDictionaryState())?.entries ?? {})).toEqual(['e1', 'e3']);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBeUndefined();
  });

  it('expired cursor re-snapshots and drops an entry missing from the snapshot', async () => {
    await seedStored();
    mockFetchSharedDictionary
      .mockRejectedValueOnce(apiError(410, 'SHARED_DICTIONARY_CURSOR_EXPIRED'))
      .mockResolvedValueOnce(listPage([entry('e1', 'Acme')], { server_time: T2 }));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).toHaveBeenNthCalledWith(2, 'ws-1', { limit: 200 });
    expect(mockFetchSharedDictionaryHides).toHaveBeenCalledWith('ws-1', { limit: 200 });
    expect((await loadSharedDictionaryState())?.entries).toEqual({
      e1: { spaceId: null, word: 'Acme' },
    });
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T2);
  });

  it('an expired hides cursor re-snapshots the whole pass', async () => {
    await seedStored({ ...STORED, hiddenIds: ['e1'] });
    mockFetchSharedDictionaryHides
      .mockRejectedValueOnce(apiError(410, 'SHARED_DICTIONARY_CURSOR_EXPIRED'))
      .mockResolvedValueOnce(hidesPage([hide('e2')]));
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(
        listPage([entry('e1', 'Acme'), entry('e2', 'Gizmo', { space_id: 'space-1' })]),
      );

    await pullSharedDictionary();

    expect(mockFetchSharedDictionaryHides).toHaveBeenNthCalledWith(2, 'ws-1', { limit: 200 });
    expect((await loadSharedDictionaryState())?.hiddenIds).toEqual(['e2']);
  });

  it.each([
    ['NOT_MEMBER', 404, 'SHARED_DICTIONARY_NOT_MEMBER'],
    ['SSO_REQUIRED', 403, 'SSO_REQUIRED'],
  ])('%s clears state', async (_label, status, code) => {
    await seedStored();
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(status, code));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockSyncState.has(SHARED_DICTIONARY_STATE_KEY)).toBe(false);
    expect(mockSyncState.has(SHARED_DICTIONARY_CURSOR_KEY)).toBe(false);
    expect(mockSyncState.has(SHARED_DICTIONARY_HIDES_CURSOR_KEY)).toBe(false);
  });

  it('reports a change when the clear removes a row this build could not read', async () => {
    mockSyncState.set(SHARED_DICTIONARY_STATE_KEY, '{not json');
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(404, 'SHARED_DICTIONARY_NOT_MEMBER'));

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });
    expect(mockSyncState.has(SHARED_DICTIONARY_STATE_KEY)).toBe(false);
  });

  it('reports no change when there was nothing to clear', async () => {
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(404, 'SHARED_DICTIONARY_NOT_MEMBER'));
    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });

    mockFetchMyWorkspaces.mockResolvedValue({ data: [] });
    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });
  });

  it('no resolvable workspace clears state', async () => {
    await seedStored();
    mockFetchMyWorkspaces.mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Other' },
      ],
    });
    mockUsageState.usage = { entitlementSources: { workspaceIds: ['ws-1', 'ws-2'] } };

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: true });

    expect(mockFetchSharedDictionary).not.toHaveBeenCalled();
    expect(await loadSharedDictionaryState()).toBeNull();
    expect(mockSyncState.has(SHARED_DICTIONARY_CURSOR_KEY)).toBe(false);
  });

  it('picks the only entitled workspace from the usage', async () => {
    mockFetchMyWorkspaces.mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Other' },
      ],
    });
    mockUsageState.usage = { entitlementSources: { workspaceIds: ['ws-2'] } };

    await pullSharedDictionary();

    expect(mockFetchSharedDictionary).toHaveBeenCalledWith('ws-2', { limit: 200 });
    expect((await loadSharedDictionaryState())?.workspaceName).toBe('Other');
  });

  it('keeps the stored state when the usage for several workspaces cannot be read', async () => {
    await seedStored();
    mockFetchMyWorkspaces.mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Other' },
      ],
    });

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });

    expect(mockUsageState.load).toHaveBeenCalled();
    expect(mockFetchSharedDictionary).not.toHaveBeenCalled();
    expect(await loadSharedDictionaryState()).toEqual(STORED);
  });

  it('a different workspace starts a fresh snapshot', async () => {
    await seedStored({ ...STORED, workspaceId: 'ws-old' });

    await pullSharedDictionary();

    expect(mockFetchSharedDictionary).toHaveBeenCalledWith('ws-1', { limit: 200 });
    expect(mockFetchSharedDictionaryHides).toHaveBeenCalledWith('ws-1', { limit: 200 });
    expect((await loadSharedDictionaryState())?.entries).toEqual({});
  });

  it('a different workspace drops the old words before its first snapshot', async () => {
    await seedStored({ ...STORED, workspaceId: 'ws-old' });
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(500));

    await expect(pullSharedDictionary()).rejects.toThrow('failed');

    expect(await loadSharedDictionaryState()).toBeNull();
  });

  it('plain 404 sets the unavailable flag and does not throw', async () => {
    const isolated = loadIsolatedPull();
    await seedStored();
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(404, undefined, isolated.ApiError));

    await expect(isolated.pull()).resolves.toEqual({ changed: false });
    expect(await loadSharedDictionaryState()).toEqual(STORED);

    // The rest of the session skips the step without a request.
    mockFetchMyWorkspaces.mockClear();
    await expect(isolated.pull()).resolves.toEqual({ changed: false });
    expect(mockFetchMyWorkspaces).not.toHaveBeenCalled();
  });

  it.each([405, 501])('a %i also marks the endpoint unavailable', async (status) => {
    const isolated = loadIsolatedPull();
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(status, undefined, isolated.ApiError));
    await expect(isolated.pull()).resolves.toEqual({ changed: false });
  });

  it('a coded 404 other than NOT_MEMBER is a normal error, not a missing endpoint', async () => {
    const isolated = loadIsolatedPull();
    await seedStored();
    mockFetchSharedDictionary.mockRejectedValueOnce(
      apiError(404, 'SOMETHING_ELSE', isolated.ApiError),
    );

    await expect(isolated.pull()).rejects.toThrow('failed');
    expect(await loadSharedDictionaryState()).toEqual(STORED);

    // The step still runs next time.
    await isolated.pull();
    expect(mockFetchSharedDictionary).toHaveBeenCalledTimes(2);
  });

  it('a snapshot without server_time stores no cursor, so the next run snapshots again', async () => {
    mockFetchSharedDictionary.mockResolvedValueOnce({
      ...listPage([entry('e1', 'Acme')]),
      server_time: undefined,
    });
    mockFetchSharedDictionaryHides.mockResolvedValueOnce({
      ...hidesPage([]),
      server_time: undefined,
    });

    await pullSharedDictionary();

    expect((await loadSharedDictionaryState())?.entries).toEqual({
      e1: { spaceId: null, word: 'Acme' },
    });
    for (const key of [
      SHARED_DICTIONARY_CURSOR_KEY,
      SHARED_DICTIONARY_CURSOR_ID_KEY,
      SHARED_DICTIONARY_HIDES_CURSOR_KEY,
      SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
    ]) {
      expect(mockSyncState.has(key)).toBe(false);
    }

    await pullSharedDictionary();

    expect(mockFetchSharedDictionary).toHaveBeenLastCalledWith('ws-1', { limit: 200 });
    expect(mockFetchSharedDictionaryHides).toHaveBeenLastCalledWith('ws-1', { limit: 200 });
  });

  it('a delta without server_time keeps the stored cursor', async () => {
    await seedStored();
    mockFetchSharedDictionary.mockResolvedValueOnce({ ...listPage([]), server_time: undefined });

    await pullSharedDictionary();

    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T0);
  });

  it('rethrows other errors', async () => {
    mockFetchSharedDictionary.mockRejectedValueOnce(apiError(500));
    await expect(pullSharedDictionary()).rejects.toThrow('failed');
  });

  // Shared lists follow the account, not cloud backup, so the upload gate never applies.
  it('checks the account before writing, never the upload gate', async () => {
    const checkpoint = jest.fn();
    await pullSharedDictionary(checkpoint);
    expect(checkpoint).toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalledWith(true);
  });

  it('writes nothing when the sync context is cancelled before the write', async () => {
    await seedStored();
    let cancelled = false;
    mockFetchSharedDictionaryHides.mockImplementationOnce(async () => {
      cancelled = true;
      return hidesPage([]);
    });
    mockFetchSharedDictionary.mockResolvedValueOnce(listPage([entry('e3', 'Widget')]));
    const checkpoint = jest.fn(() => {
      if (cancelled) throw new Error('cancelled');
    });

    await expect(pullSharedDictionary(checkpoint)).rejects.toThrow('cancelled');

    expect(await loadSharedDictionaryState()).toEqual(STORED);
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T0);
  });

  it('does not rewrite an unchanged state', async () => {
    await seedStored();
    mockSyncStateWrites.length = 0;

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });

    expect(mockSyncStateWrites).not.toContain(SHARED_DICTIONARY_STATE_KEY);
    // The cursors still advance.
    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T1);
  });

  it('uses the workspaces the spaces pass already read', async () => {
    await pullSharedDictionary(undefined, [{ id: 'ws-1', name: 'Acme' }]);

    expect(mockFetchMyWorkspaces).not.toHaveBeenCalled();
    expect(mockFetchSharedDictionary).toHaveBeenCalledWith('ws-1', { limit: 200 });
  });

  it('fetches the workspaces itself when the spaces pass has none', async () => {
    await pullSharedDictionary(undefined, null);

    expect(mockFetchMyWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("ignores another account's cached usage when picking the workspace", async () => {
    mockFetchMyWorkspaces.mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Other' },
      ],
    });
    mockUsageState.usage = { entitlementSources: { workspaceIds: ['ws-1'] } };
    mockUsageState.ownerKey = 'someone-else:cookie';
    mockUsageState.load.mockImplementation(async () => {
      mockUsageState.usage = { entitlementSources: { workspaceIds: ['ws-2'] } };
      mockUsageState.ownerKey = OWNER;
      return { usage: mockUsageState.usage };
    });

    await pullSharedDictionary();

    expect(mockUsageState.load).toHaveBeenCalled();
    expect(mockFetchSharedDictionary).toHaveBeenCalledWith('ws-2', { limit: 200 });
  });

  it('keeps the stored state when the usage load still belongs to another account', async () => {
    await seedStored();
    mockFetchMyWorkspaces.mockResolvedValue({
      data: [
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Other' },
      ],
    });
    mockUsageState.usage = { entitlementSources: { workspaceIds: ['ws-2'] } };
    mockUsageState.ownerKey = 'someone-else:cookie';

    await expect(pullSharedDictionary()).resolves.toEqual({ changed: false });

    expect(mockFetchSharedDictionary).not.toHaveBeenCalled();
    expect(await loadSharedDictionaryState()).toEqual(STORED);
  });

  it('a coded 400 invalid request is rethrown as a server error, never a missing endpoint', async () => {
    const isolated = loadIsolatedPull();
    await seedStored();
    mockFetchSharedDictionary.mockRejectedValueOnce(
      apiError(400, 'SHARED_DICTIONARY_INVALID_REQUEST', isolated.ApiError),
    );

    const failure = await isolated.pull().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(isolated.ApiError as new () => Error);
    expect(failure).toMatchObject({ status: 400, code: 'SHARED_DICTIONARY_INVALID_REQUEST' });
    expect(await loadSharedDictionaryState()).toEqual(STORED);

    await isolated.pull();
    expect(mockFetchSharedDictionary).toHaveBeenCalledTimes(2);
  });
});

describe('pullSharedDictionary stalled pages', () => {
  const page = (overrides: Partial<RemoteSharedEntry>): RemoteSharedEntry =>
    entry('e1', 'Acme', overrides);

  it('a snapshot page that repeats its cursor throws a SyncStalledError and saves nothing', async () => {
    const stuck = page({});
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([stuck], { hasMore: true }))
      .mockResolvedValueOnce(listPage([stuck], { hasMore: true }));

    const failure = await pullSharedDictionary().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(SyncStalledError);
    expect((failure as Error).name).toBe('SyncStalledError');
    expect(mockSyncState.has(SHARED_DICTIONARY_CURSOR_KEY)).toBe(false);
  });

  it('a delta page that repeats its cursor throws a SyncStalledError and keeps the cursor', async () => {
    await seedStored();
    const stuck = page({});
    mockFetchSharedDictionary
      .mockResolvedValueOnce(listPage([stuck], { hasMore: true }))
      .mockResolvedValueOnce(listPage([stuck], { hasMore: true }));

    await expect(pullSharedDictionary()).rejects.toBeInstanceOf(SyncStalledError);

    expect(mockSyncState.get(SHARED_DICTIONARY_CURSOR_KEY)).toBe(T0);
    expect(await loadSharedDictionaryState()).toEqual(STORED);
  });

  it.each([
    ['snapshot', false],
    ['delta', true],
  ])('a hides %s page that repeats its cursor throws a SyncStalledError', async (_kind, seed) => {
    if (seed) await seedStored();
    mockFetchSharedDictionaryHides
      .mockResolvedValueOnce(hidesPage([hide('e1')], { hasMore: true }))
      .mockResolvedValueOnce(hidesPage([hide('e1')], { hasMore: true }));

    await expect(pullSharedDictionary()).rejects.toBeInstanceOf(SyncStalledError);
  });
});

describe('resetAllPullCursors', () => {
  it('resetAllPullCursors clears the shared keys', () => {
    for (const key of [
      SHARED_DICTIONARY_CURSOR_KEY,
      SHARED_DICTIONARY_CURSOR_ID_KEY,
      SHARED_DICTIONARY_HIDES_CURSOR_KEY,
      SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
    ]) {
      mockSyncState.set(key, 'x');
    }

    resetAllPullCursors();

    expect(mockSyncState.has(SHARED_DICTIONARY_CURSOR_KEY)).toBe(false);
    expect(mockSyncState.has(SHARED_DICTIONARY_CURSOR_ID_KEY)).toBe(false);
    expect(mockSyncState.has(SHARED_DICTIONARY_HIDES_CURSOR_KEY)).toBe(false);
    expect(mockSyncState.has(SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY)).toBe(false);
  });
});
