jest.mock('../privateNoteDeletion', () => ({
  pushPrivateNoteDeletes: jest.fn(),
  clearPrivateNoteDeletionQueue: jest.fn(),
}));
// syncEngine.ts pulls in a long chain of stores/repositories/sync modules.
// Every dependency is mocked so this file can exercise runSyncNow's gating
// and error-handling logic (in particular the new policyBlocked state) in
// isolation, without touching SQLite, expo/fetch, or better-auth.
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/apiClient', () => {
  class MockApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    isPolicyCloudBackupBlockedError: (error: unknown): boolean =>
      error instanceof MockApiError &&
      error.status === 403 &&
      error.code === 'POLICY_CLOUD_BACKUP_BLOCKED',
  };
});

const mockAuthState = { user: { id: 'user-1' } as { id: string } | null, isGuest: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => mockAuthState,
    subscribe: jest.fn(() => () => {}),
  },
}));

const mockConfigState = {
  config: { cloudBackupEnabled: true } as { cloudBackupEnabled: boolean } | undefined,
};
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { subscribe: jest.fn(() => () => {}), getState: () => mockConfigState },
}));

jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: {
    getState: () => ({
      loadFolders: jest.fn(),
      loadSpaces: jest.fn(),
      loadNotes: jest.fn(),
    }),
  },
}));

jest.mock('@/data', () => ({
  notesRepository: {
    // Only the last-synced user is seeded; the anonymous link token and every
    // other key read as absent, so an id change is an account switch here.
    getSyncState: jest.fn((key: string) => (key === 'sync.user_id' ? 'user-1' : null)),
    setSyncState: jest.fn(),
    clearSyncState: jest.fn(),
    wipeAllSyncableData: jest.fn(),
    dropRemoteIdsForAccountLink: jest.fn(),
  },
}));

const mockFetchUsage = jest.fn();
jest.mock('@/data/remote/usageApi', () => ({
  fetchUsage: (...args: unknown[]) => mockFetchUsage(...args),
}));

const mockPullFolders = jest.fn();
const mockPullFoldersTeam = jest.fn();
const mockPullNotes = jest.fn();
const mockPullNotesTeam = jest.fn();
const mockPushFolders = jest.fn();
const mockPushNotes = jest.fn();
const mockPullDictionary = jest.fn();
const mockPushDictionary = jest.fn();
const mockPullSnippets = jest.fn();
const mockPushSnippets = jest.fn();
const mockSyncSpaces = jest.fn();
jest.mock('../syncSpaces', () => ({ syncSpaces: (...args: unknown[]) => mockSyncSpaces(...args) }));
jest.mock('../pullFolders', () => ({
  pullFolders: (...args: unknown[]) => mockPullFolders(...args),
}));
jest.mock('../pullFoldersTeam', () => ({
  pullFoldersTeam: (...args: unknown[]) => mockPullFoldersTeam(...args),
}));
jest.mock('../pullNotes', () => ({ pullNotes: (...args: unknown[]) => mockPullNotes(...args) }));
jest.mock('../pullNotesTeam', () => ({
  pullNotesTeam: (...args: unknown[]) => mockPullNotesTeam(...args),
}));
jest.mock('../pushFolders', () => ({
  pushFolders: (...args: unknown[]) => mockPushFolders(...args),
}));
jest.mock('../pushNotes', () => ({ pushNotes: (...args: unknown[]) => mockPushNotes(...args) }));
jest.mock('../pullDictionary', () => ({
  pullDictionary: (...args: unknown[]) => mockPullDictionary(...args),
}));
jest.mock('../pushDictionary', () => ({
  pushDictionary: (...args: unknown[]) => mockPushDictionary(...args),
}));
jest.mock('../pullSnippets', () => ({
  pullSnippets: (...args: unknown[]) => mockPullSnippets(...args),
}));
jest.mock('../pushSnippets', () => ({
  pushSnippets: (...args: unknown[]) => mockPushSnippets(...args),
}));

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));

const mockRunInitialBackfillIfNeeded = jest.fn();
jest.mock('../initialBackfill', () => ({
  runInitialBackfillIfNeeded: (...args: unknown[]) => mockRunInitialBackfillIfNeeded(...args),
}));

import { requestSync } from '../syncEngine';
import { pushPrivateNoteDeletes } from '../privateNoteDeletion';
import { useSyncStore } from '../useSyncStore';
import { ApiError } from '@/lib/apiClient';
import { notesRepository } from '@/data';
import * as Sentry from '@sentry/react-native';

// Flushes the microtask queue (via a macrotask boundary) enough times to
// drain runSyncNow's long await chain — requestSync doesn't return the
// underlying promise, so tests can't just `await` it directly.
async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.user = { id: 'user-1' };
  mockAuthState.isGuest = false;
  mockConfigState.config = { cloudBackupEnabled: true };
  mockFetchUsage.mockResolvedValue({ isSubscribed: true });
  mockSyncSpaces.mockResolvedValue({ capable: true, activeSpaces: [] });
  mockPullFolders.mockResolvedValue(undefined);
  mockPullFoldersTeam.mockResolvedValue(undefined);
  mockPullNotes.mockResolvedValue(undefined);
  mockPullNotesTeam.mockResolvedValue(undefined);
  mockPushFolders.mockResolvedValue(undefined);
  mockPushNotes.mockResolvedValue(undefined);
  mockPullDictionary.mockResolvedValue(undefined);
  mockPushDictionary.mockResolvedValue(undefined);
  mockPullSnippets.mockResolvedValue(undefined);
  mockPushSnippets.mockResolvedValue(undefined);
  mockRunInitialBackfillIfNeeded.mockResolvedValue(undefined);
  useSyncStore.setState({
    status: 'idle',
    lastError: null,
    lastSyncAt: null,
    subscriptionRequired: false,
    policyBlocked: false,
  });
});

describe('policyBlocked on POLICY_CLOUD_BACKUP_BLOCKED', () => {
  it('sets policyBlocked + idle (no lastError) and does not report to Sentry when pushNotes trips it', async () => {
    mockPushNotes.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    // Expected/handled gate, not an unexpected failure — must not spam Sentry
    // the way a genuine sync error does (see the "generic error" test below).
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('also trips from pushFolders (any push/pull call, not just pushNotes)', async () => {
    mockPushFolders.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    // pushNotes must never run once pushFolders has already stopped the run.
    expect(mockPushNotes).not.toHaveBeenCalled();
  });

  it('does not call pushNotes at all when pushFolders already tripped the block (stops cleanly, no further writes)', async () => {
    mockPushFolders.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));
    requestSync('manual');
    await flush();
    expect(mockPushNotes).not.toHaveBeenCalled();
  });

  it('clears policyBlocked once a later run gets past the gates and completes', async () => {
    mockPushNotes.mockRejectedValueOnce(
      new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );
    requestSync('manual');
    await flush();
    expect(useSyncStore.getState().policyBlocked).toBe(true);

    // Second run: pushNotes now succeeds.
    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(false);
    expect(state.status).toBe('idle');
  });

  it('a generic error (unrelated ApiError) still goes through the normal error path, not policyBlocked', async () => {
    mockPushNotes.mockRejectedValue(new ApiError('Server error', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(false);
    expect(state.status).toBe('error');
    expect(state.lastError).toBeInstanceOf(Error);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('trips from pushDictionary too — a run with only a pending dictionary change stops before snippets and does not finalize as success', async () => {
    // Dictionary/snippets sync is normally isolated (a dictionary outage
    // shouldn't block note uploads), but a policy block must still stop the
    // whole run rather than being swallowed by that isolation.
    useSyncStore.setState({ lastSyncAt: '2026-08-01T00:00:00.000Z' });
    mockPushDictionary.mockRejectedValue(
      new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    // The run must not have reached the "success" finalization (which would
    // stamp a fresh lastSyncAt) nor continued into the independent snippets
    // sub-sync.
    expect(state.lastSyncAt).toBe('2026-08-01T00:00:00.000Z');
    expect(mockPullSnippets).not.toHaveBeenCalled();
    expect(mockPushSnippets).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('trips from pushSnippets too, after dictionary already succeeded', async () => {
    mockPushSnippets.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    // Dictionary sub-sync ran fine; the run only stops once snippets trips it.
    expect(mockPushDictionary).toHaveBeenCalled();
  });
});

describe('syncSpaces run order', () => {
  it('runs private cloud cleanup with backup disabled before a failing spaces request', async () => {
    mockConfigState.config = { cloudBackupEnabled: false };
    mockSyncSpaces.mockRejectedValue(new ApiError('spaces endpoint exploded', 500));

    requestSync('manual');
    await flush();

    expect(pushPrivateNoteDeletes).toHaveBeenCalledWith(expect.any(Function));
    expect(mockSyncSpaces).toHaveBeenCalled();
    expect(jest.mocked(pushPrivateNoteDeletes).mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncSpaces.mock.invocationCallOrder[0],
    );
    expect(mockFetchUsage).not.toHaveBeenCalled();
    expect(mockPushNotes).not.toHaveBeenCalled();
  });

  it('runs syncSpaces before pullFolders and pullNotes', async () => {
    requestSync('manual');
    await flush();

    expect(mockSyncSpaces).toHaveBeenCalled();
    expect(mockPullFolders).toHaveBeenCalled();
    expect(mockPullNotes).toHaveBeenCalled();
    const spacesOrder = mockSyncSpaces.mock.invocationCallOrder[0];
    const foldersOrder = mockPullFolders.mock.invocationCallOrder[0];
    const notesOrder = mockPullNotes.mock.invocationCallOrder[0];
    expect(spacesOrder).toBeLessThan(foldersOrder);
    expect(foldersOrder).toBeLessThan(notesOrder);
  });

  it('a thrown syncSpaces error fails the run like any other pull failure, and folder/note pulls never run', async () => {
    mockSyncSpaces.mockRejectedValue(new ApiError('spaces endpoint exploded', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError).toBeInstanceOf(Error);
    expect(state.lastError?.message).toBe('spaces endpoint exploded');
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockPullFolders).not.toHaveBeenCalled();
    expect(mockPullNotes).not.toHaveBeenCalled();
    expect(mockPushFolders).not.toHaveBeenCalled();
  });

  it('a POLICY_CLOUD_BACKUP_BLOCKED error from syncSpaces stops the run the same way as any other pass', async () => {
    mockSyncSpaces.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    expect(mockPullFolders).not.toHaveBeenCalled();
  });
});

describe('team pull passes', () => {
  it('runs folders then notes in each scope: personal folders → team folders → personal notes → team notes', async () => {
    requestSync('manual');
    await flush();

    const order = [
      mockSyncSpaces,
      mockPullFolders,
      mockPullFoldersTeam,
      mockPullNotes,
      mockPullNotesTeam,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((value) => value !== undefined)).toBe(true);
    // The pushes still come last.
    expect(order[order.length - 1]).toBeLessThan(mockPushFolders.mock.invocationCallOrder[0]);
  });

  it('never runs the team passes when the backend is not team-spaces capable', async () => {
    mockSyncSpaces.mockResolvedValue({ capable: false, activeSpaces: [] });

    requestSync('manual');
    await flush();

    expect(mockPullFolders).toHaveBeenCalled();
    expect(mockPullNotes).toHaveBeenCalled();
    expect(mockPullFoldersTeam).not.toHaveBeenCalled();
    expect(mockPullNotesTeam).not.toHaveBeenCalled();
    // The rest of the run is unaffected.
    expect(useSyncStore.getState().status).toBe('idle');
  });

  it('a thrown team pull failure fails the run like any other pull failure', async () => {
    mockPullNotesTeam.mockRejectedValue(new ApiError('team pull exploded', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('team pull exploded');
    expect(mockPushFolders).not.toHaveBeenCalled();
  });
});

describe('426 UPGRADE_REQUIRED during sync', () => {
  it('sets lastError to the fixed upgrade message and stops the run via the existing error path', async () => {
    // apiClient.ts already normalizes the 426 message before throwing, so a
    // pull call (which propagates ApiError untouched — see pullFolders.ts)
    // arrives here with the friendly message already attached.
    mockPullFolders.mockRejectedValue(
      new ApiError('Update OpenWhispr to keep using cloud features.', 426, 'UPGRADE_REQUIRED'),
    );

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('Update OpenWhispr to keep using cloud features.');
    expect(state.policyBlocked).toBe(false);
    expect(state.subscriptionRequired).toBe(false);
  });
});

describe('paygate rework: team-only sync when the personal gate is closed', () => {
  it('full sync runs unchanged when subscribed and cloud backup is enabled: pushFolders/pushNotes carry no teamOnly arg', async () => {
    requestSync('manual');
    await flush();

    expect(mockRunInitialBackfillIfNeeded).toHaveBeenCalled();
    expect(mockPullFolders).toHaveBeenCalled();
    expect(mockPullNotes).toHaveBeenCalled();
    // Default teamOnly=false — called with no arguments at all.
    expect(mockPushFolders).toHaveBeenCalledWith(false, expect.any(Function));
    expect(mockPushNotes).toHaveBeenCalledWith(false, expect.any(Function));
    expect(mockPullDictionary).toHaveBeenCalled();
    expect(mockPullSnippets).toHaveBeenCalled();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.subscriptionRequired).toBe(false);
    expect(state.lastSyncAt).toEqual(expect.any(String));
  });

  it('unsubscribed: runs spaces + team pulls + team-scoped pushes only, skips backfill/personal pulls/personal pushes/dictionary/snippets, ends idle with subscriptionRequired true', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });

    requestSync('manual');
    await flush();

    expect(mockSyncSpaces).toHaveBeenCalled();
    expect(mockPullFoldersTeam).toHaveBeenCalled();
    expect(mockPullNotesTeam).toHaveBeenCalled();
    expect(mockPushFolders).toHaveBeenCalledWith(true, expect.any(Function));
    expect(mockPushNotes).toHaveBeenCalledWith(true, expect.any(Function));

    expect(mockRunInitialBackfillIfNeeded).not.toHaveBeenCalled();
    expect(mockPullFolders).not.toHaveBeenCalled();
    expect(mockPullNotes).not.toHaveBeenCalled();
    expect(mockPullDictionary).not.toHaveBeenCalled();
    expect(mockPushDictionary).not.toHaveBeenCalled();
    expect(mockPullSnippets).not.toHaveBeenCalled();
    expect(mockPushSnippets).not.toHaveBeenCalled();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.subscriptionRequired).toBe(true);
    expect(state.lastError).toBeNull();
  });

  it('cloudBackupEnabled=false likewise runs the team-only pass, without even checking subscription', async () => {
    mockConfigState.config = { cloudBackupEnabled: false };

    requestSync('manual');
    await flush();

    expect(mockPullFoldersTeam).toHaveBeenCalled();
    expect(mockPullNotesTeam).toHaveBeenCalled();
    expect(mockPushFolders).toHaveBeenCalledWith(true, expect.any(Function));
    expect(mockPushNotes).toHaveBeenCalledWith(true, expect.any(Function));
    expect(mockPullFolders).not.toHaveBeenCalled();
    expect(mockPullNotes).not.toHaveBeenCalled();
    expect(mockFetchUsage).not.toHaveBeenCalled();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    // Cloud backup being off (not a failed subscription check) is the old
    // "paused" case, not the "upgrade" case — preserve that distinction.
    expect(state.subscriptionRequired).toBe(false);
  });

  it('capability=false + unsubscribed: clean no-op, no team calls, no error', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
    mockSyncSpaces.mockResolvedValue({ capable: false, activeSpaces: [] });

    requestSync('manual');
    await flush();

    expect(mockPullFoldersTeam).not.toHaveBeenCalled();
    expect(mockPullNotesTeam).not.toHaveBeenCalled();
    expect(mockPushFolders).not.toHaveBeenCalled();
    expect(mockPushNotes).not.toHaveBeenCalled();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(state.subscriptionRequired).toBe(true);
  });

  it('does not stamp lastSyncAt after a team-only pass', async () => {
    useSyncStore.setState({ lastSyncAt: '2026-08-01T00:00:00.000Z' });
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });

    requestSync('manual');
    await flush();

    expect(useSyncStore.getState().lastSyncAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('the account-switch wipe still runs ahead of a team-only pass', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
    const mockGetSyncState = notesRepository.getSyncState as jest.Mock;
    mockGetSyncState.mockReturnValueOnce('previous-user');

    requestSync('manual');
    await flush();

    expect(notesRepository.wipeAllSyncableData).toHaveBeenCalled();
    expect(notesRepository.setSyncState).toHaveBeenCalledWith('sync.user_id', 'user-1');
  });

  it('a policyBlocked error from a team push still stops the run cleanly, same as a full sync', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
    mockPushNotes.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a thrown team pull failure fails the run with status error, same as a full sync', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
    mockPullNotesTeam.mockRejectedValue(new ApiError('team pull exploded', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('team pull exploded');
    expect(mockPushNotes).not.toHaveBeenCalled();
  });
});

// Fix round 1, Finding 3: the team-only pass now runs on every foreground
// trigger for every unpaid user (the largest segment) instead of returning
// immediately. A network-level failure (offline, DNS, timeout — a plain
// thrown Error/TypeError, never an ApiError the server actually answered
// with) must not surface as status:'error' + Sentry noise on every one of
// them while offline.
describe('team-only pass: network-level failures end quietly (fix round 1, Finding 3)', () => {
  beforeEach(() => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
  });

  it('a plain thrown error (not an ApiError) from a team pull ends idle quietly, with a breadcrumb but no Sentry.captureException', async () => {
    mockPullFoldersTeam.mockRejectedValue(new TypeError('Network request failed'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'sync',
        message: expect.stringContaining('network-level error'),
      }),
    );
  });

  it('a plain thrown error from a team push (pushFolders(true)/pushNotes(true)) also ends idle quietly', async () => {
    mockPushNotes.mockRejectedValue(new Error('fetch failed'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a real server error (ApiError, e.g. 500) from the team-only path still goes through the normal error path', async () => {
    mockPullNotesTeam.mockRejectedValue(new ApiError('server exploded', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('server exploded');
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('a POLICY_CLOUD_BACKUP_BLOCKED from the team-only path still stops the run via stopSyncForPolicyBlock, not the quiet path', async () => {
    mockPushFolders.mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.policyBlocked).toBe(true);
    expect(state.status).toBe('idle');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Fix round 2, Finding 2: syncSpaces() runs ahead of both branches, outside
  // the catch above. Offline, fetchMySpaces throws a plain TypeError — which
  // reached the top-level catch and reported every unpaid user's every
  // foreground trigger as a sync error.
  it('a network-level failure from syncSpaces on a gated run ends idle quietly, with no Sentry.captureException', async () => {
    mockSyncSpaces.mockRejectedValue(new TypeError('Network request failed'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'sync',
        message: expect.stringContaining('spaces pass: network-level error'),
      }),
    );
    // The gate's own answer must survive the quiet exit — it drives the
    // subscribe prompt, and this run never disproved it.
    expect(state.subscriptionRequired).toBe(true);
    // Nothing may run once the spaces pass failed: the team passes depend on it.
    expect(mockPullFoldersTeam).not.toHaveBeenCalled();
  });

  it('a real server error (ApiError, e.g. 500) from syncSpaces on a gated run still goes down the error path', async () => {
    mockSyncSpaces.mockRejectedValue(new ApiError('spaces exploded', 500));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('spaces exploded');
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('does not affect the not-team-spaces-capable no-op branch (nothing throws there)', async () => {
    mockSyncSpaces.mockResolvedValue({ capable: false, activeSpaces: [] });

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('leaves a full-sync run unchanged: the same failure from syncSpaces still surfaces as an error', async () => {
    mockFetchUsage.mockResolvedValue({ isSubscribed: true });
    mockSyncSpaces.mockRejectedValue(new TypeError('Network request failed'));

    requestSync('manual');
    await flush();

    const state = useSyncStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError?.message).toBe('Network request failed');
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// Fix round 1, Finding 4: the module-level subscription cache
// (subscriptionCached/subscriptionCachedAt) must not survive an account
// switch — otherwise a foreground-triggered run for the NEW user could reuse
// the PREVIOUS user's cached answer for up to SUBSCRIPTION_CACHE_TTL_MS
// (60s) and pick the wrong gate branch.
describe('subscription cache reset on account switch (fix round 1, Finding 4)', () => {
  it('a later non-forceFresh (foreground) check for the new user does not reuse the previous user cached answer', async () => {
    // Populate the cache as user-1: subscribed. 'manual' still writes the
    // cache on a successful fetch even though it never reads it.
    mockFetchUsage.mockResolvedValue({ isSubscribed: true });
    requestSync('manual');
    await flush();
    expect(mockFetchUsage).toHaveBeenCalledTimes(1);

    // Switch to user-2, still within the 60s cache TTL. getSyncState's mock
    // has no real backing store (setSyncState doesn't change what it
    // returns), so it still answers 'user-1' — the switch is detected here.
    // This first post-switch run is itself 'foreground' (non-forceFresh): it
    // still reads whatever the cache held BEFORE this run's own wipe/reset
    // runs (the reset can only take effect for a LATER run) — that residual
    // ordering is unchanged by this fix and not what's under test here.
    mockAuthState.user = { id: 'user-2' };
    mockFetchUsage.mockClear();
    mockFetchUsage.mockResolvedValue({ isSubscribed: false });
    requestSync('foreground');
    await flush();
    expect(notesRepository.wipeAllSyncableData).toHaveBeenCalled();

    // A second foreground trigger for user-2, past the 30s foreground
    // throttle. With the cache reset during the switch run above,
    // subscriptionCachedAt is 0 going in, so this is unconditionally a cache
    // miss (a fresh fetchUsage call) regardless of how little time has
    // passed — proving the previous user's answer was not carried forward.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      jest.advanceTimersByTime(31_000);
      mockFetchUsage.mockClear();
      mockFetchUsage.mockResolvedValue({ isSubscribed: false });
      requestSync('foreground');
      await flush();
    } finally {
      jest.useRealTimers();
    }

    expect(mockFetchUsage).toHaveBeenCalledTimes(1);
    const state = useSyncStore.getState();
    expect(state.subscriptionRequired).toBe(true);
  });
});

describe('in-flight cancellation', () => {
  it('stops after an account changes during the spaces request', async () => {
    mockSyncSpaces.mockImplementationOnce(async () => {
      mockAuthState.user = { id: 'other-account' };
      return { capable: true, activeSpaces: [] };
    });
    requestSync('manual');
    await flush();
    expect(mockRunInitialBackfillIfNeeded).not.toHaveBeenCalled();
    expect(mockPushNotes).not.toHaveBeenCalled();
  });

  it('stops subsequent uploads when backup is disabled during folder upload', async () => {
    mockPushFolders.mockImplementationOnce(async () => {
      mockConfigState.config = { cloudBackupEnabled: false };
    });
    requestSync('manual');
    await flush();
    expect(mockPushNotes).not.toHaveBeenCalled();
    expect(mockPushDictionary).not.toHaveBeenCalled();
    expect(mockPushSnippets).not.toHaveBeenCalled();
  });
});
