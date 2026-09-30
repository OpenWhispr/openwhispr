jest.mock('../privateNoteDeletion', () => ({
  pushPrivateNoteDeletes: jest.fn(),
  clearPrivateNoteDeletionQueue: jest.fn(),
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

// The real auth store pulls in better-auth, which ships ESM that jest does not
// transform — every store test in this repo mocks it for the same reason.
type MockAuthState = {
  user: { id: string; isAnonymous: boolean } | null;
  isGuest: boolean;
  sessionCookie: string | null;
};
// Replaced, never mutated: zustand hands out a new state object per set(), so a
// run that captured getState() before a sign-in must keep seeing the old user.
let mockAuthState: MockAuthState = { user: null, isGuest: false, sessionCookie: null };
function setAuthState(next: MockAuthState): void {
  mockAuthState = next;
}
const mockAuthSubscribers = new Set<(state: MockAuthState, prevState: MockAuthState) => void>();
const authSubscriber = (state: MockAuthState, prevState: MockAuthState): void => {
  for (const listener of mockAuthSubscribers) listener(state, prevState);
};
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => mockAuthState,
    subscribe: (listener: (state: MockAuthState, prevState: MockAuthState) => void) => {
      mockAuthSubscribers.add(listener);
      return () => {
        mockAuthSubscribers.delete(listener);
      };
    },
  },
}));

const configState = { config: { cloudBackupEnabled: true } };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => configState, subscribe: () => () => {} },
}));

const noopStore = { getState: () => ({ reset: jest.fn(), load: jest.fn(), set: jest.fn() }) };
jest.mock('@/store/useDictionaryStore', () => ({ useDictionaryStore: noopStore }));
jest.mock('@/store/useSnippetsStore', () => ({ useSnippetsStore: noopStore }));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: {
    getState: () => ({ loadFolders: jest.fn(), loadSpaces: jest.fn(), loadNotes: jest.fn() }),
  },
}));
jest.mock('../useSyncStore', () => ({ useSyncStore: { getState: () => ({ set: jest.fn() }) } }));

// apiClient pulls in expo/fetch, which jest-expo cannot instantiate.
jest.mock('@/lib/apiClient', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  isPolicyCloudBackupBlockedError: () => false,
}));

jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    clearSyncState: jest.fn(),
    wipeAllSyncableData: jest.fn(),
    dropRemoteIdsForAccountLink: jest.fn(),
  },
}));
jest.mock('@/data/remote/usageApi', () => ({ fetchUsage: jest.fn() }));
// The spaces pass runs ahead of the identity reconciliation under test; a
// backend without team spaces keeps the run on the personal path.
const mockSyncSpaces = jest.fn();
jest.mock('../syncSpaces', () => ({
  syncSpaces: (...args: unknown[]) => mockSyncSpaces(...args),
}));
jest.mock('../pullFolders', () => ({ pullFolders: jest.fn() }));
jest.mock('../pullFoldersTeam', () => ({ pullFoldersTeam: jest.fn() }));
jest.mock('../pullNotes', () => ({ pullNotes: jest.fn() }));
jest.mock('../pullNotesTeam', () => ({ pullNotesTeam: jest.fn() }));
jest.mock('../pushFolders', () => ({ pushFolders: jest.fn() }));
jest.mock('../pushNotes', () => ({ pushNotes: jest.fn() }));
jest.mock('../pullDictionary', () => ({ pullDictionary: jest.fn() }));
jest.mock('../pushDictionary', () => ({ pushDictionary: jest.fn() }));
jest.mock('../pullSnippets', () => ({ pullSnippets: jest.fn() }));
jest.mock('../pushSnippets', () => ({ pushSnippets: jest.fn() }));
jest.mock('../initialBackfill', () => ({ runInitialBackfillIfNeeded: jest.fn() }));

import { initSyncTriggers, requestSync, teardownSyncTriggers } from '../syncEngine';
import { notesRepository } from '@/data';
import { fetchUsage } from '@/data/remote/usageApi';
import { runInitialBackfillIfNeeded } from '../initialBackfill';
import { clearPrivateNoteDeletionQueue, pushPrivateNoteDeletes } from '../privateNoteDeletion';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;
const mockFetchUsage = fetchUsage as jest.MockedFunction<typeof fetchUsage>;
const mockBackfill = runInitialBackfillIfNeeded as jest.MockedFunction<
  typeof runInitialBackfillIfNeeded
>;

function signIn(id: string, isAnonymous: boolean): void {
  setAuthState({ user: { id, isAnonymous }, isGuest: false, sessionCookie: 'session=test' });
}

/** Sync state the engine reads, seeded per test and updated by setSyncState. */
function seedSyncState(initial: Record<string, string>): Record<string, string> {
  const state = { ...initial };
  mockRepo.getSyncState.mockImplementation((key: string) => state[key] ?? null);
  mockRepo.setSyncState.mockImplementation((key: string, value: string) => {
    state[key] = value;
  });
  mockRepo.clearSyncState.mockImplementation((key: string) => {
    delete state[key];
  });
  return state;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets a floating runSyncNow promise chain settle completely. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchUsage.mockResolvedValue({ isSubscribed: true } as never);
  mockBackfill.mockResolvedValue(undefined);
  mockSyncSpaces.mockResolvedValue({ capable: false, activeSpaces: [] });
});

describe('syncEngine identity transitions', () => {
  it('discards the anonymous account deletion queue before cleanup under the linked account', async () => {
    seedSyncState({
      'sync.user_id': 'anon-user',
      'sync.anonymous_user_id': 'anon-user',
    });
    signIn('real-user', false);

    requestSync('sign-in');
    await flush();

    expect(clearPrivateNoteDeletionQueue).toHaveBeenCalledTimes(1);
    expect(pushPrivateNoteDeletes).toHaveBeenCalled();
    expect(jest.mocked(clearPrivateNoteDeletionQueue).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(pushPrivateNoteDeletes).mock.invocationCallOrder[0],
    );
  });

  it('claims local data when an anonymous onboarding user signs up', async () => {
    const state = seedSyncState({
      'sync.user_id': 'anon-user',
      'sync.anonymous_user_id': 'anon-user',
    });
    signIn('real-user', false);

    requestSync('sign-in');
    await flush();

    expect(mockRepo.wipeAllSyncableData).not.toHaveBeenCalled();
    expect(mockBackfill).toHaveBeenCalledWith('real-user', expect.any(Function));
    expect(state['sync.user_id']).toBe('real-user');
    // The link is consumed: a later switch away from this account must wipe.
    expect(state['sync.anonymous_user_id']).toBeUndefined();
  });

  it('still wipes when switching between two real accounts', async () => {
    seedSyncState({ 'sync.user_id': 'first-user' });
    signIn('second-user', false);

    requestSync('sign-in');
    await flush();

    expect(mockRepo.wipeAllSyncableData).toHaveBeenCalledTimes(1);
    expect(mockRepo.dropRemoteIdsForAccountLink).not.toHaveBeenCalled();
  });

  // The server migrates billing only: every remote id and pull cursor on the
  // device still points at the anonymous user's rows, which the new account
  // does not own. Left alone, pushed notes never reach the account and an
  // existing account's older notes are never pulled.
  it('re-adopts local rows and replays pulls from scratch when linking', async () => {
    const state = seedSyncState({
      'sync.user_id': 'anon-user',
      'sync.anonymous_user_id': 'anon-user',
      'notes.last_sync_at': '2026-09-01T00:00:00.000Z',
      'folders.last_sync_at': '2026-09-01T00:00:00.000Z',
      'dictionary.last_sync_at': '2026-09-01T00:00:00.000Z',
      'dictionary.last_sync_id': 'dict-9',
      'snippets.last_sync_at': '2026-09-01T00:00:00.000Z',
      'snippets.last_sync_id': 'snip-9',
      'notes.team.last_sync_at': '2026-09-01T00:00:00.000Z',
    });
    signIn('real-user', false);

    requestSync('sign-in');
    await flush();

    expect(mockRepo.dropRemoteIdsForAccountLink).toHaveBeenCalledTimes(1);
    for (const key of [
      'notes.last_sync_at',
      'folders.last_sync_at',
      'dictionary.last_sync_at',
      'dictionary.last_sync_id',
      'snippets.last_sync_at',
      'snippets.last_sync_id',
      'notes.team.last_sync_at',
    ]) {
      expect(state[key]).toBeUndefined();
    }
    expect(state['sync.user_id']).toBe('real-user');
  });

  // The paygate check is a network round trip. A foreground run that parks on
  // it while the user signs up must not resume with its pre-signup snapshot
  // and read the new id as an account switch.
  it('does not wipe when a run that began anonymous finishes after the sign-in run', async () => {
    const state = seedSyncState({
      'sync.user_id': 'anon-user',
      'sync.anonymous_user_id': 'anon-user',
    });
    const gate = deferred<{ isSubscribed: boolean }>();
    mockFetchUsage.mockReturnValueOnce(gate.promise as never);
    // Earlier runs in this file primed the 60 s subscription cache; the race
    // needs the paygate to actually go to the network.
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    signIn('anon-user', true);

    try {
      requestSync('foreground');
      await flush();
      signIn('real-user', false);
      requestSync('sign-in');
      await flush();
      gate.resolve({ isSubscribed: true });
      await flush();
    } finally {
      clock.mockRestore();
    }

    expect(mockRepo.wipeAllSyncableData).not.toHaveBeenCalled();
    expect(state['sync.user_id']).toBe('real-user');
    expect(mockBackfill).toHaveBeenCalledWith('real-user', expect.any(Function));
  });

  it('records which anonymous user the local rows belong to', async () => {
    const state = seedSyncState({});
    signIn('anon-user', true);

    requestSync('sign-in');
    await flush();

    expect(mockRepo.wipeAllSyncableData).not.toHaveBeenCalled();
    expect(state['sync.user_id']).toBe('anon-user');
    expect(state['sync.anonymous_user_id']).toBe('anon-user');
  });

  // The link token names the anonymous user whose rows are on the device, so a
  // different identity showing up later — even another anonymous one, after
  // the first session expired and a new one was minted — is judged by that id.
  it('treats a re-minted anonymous session as a link, not a switch', async () => {
    const state = seedSyncState({
      'sync.user_id': 'anon-old',
      'sync.anonymous_user_id': 'anon-old',
    });
    signIn('anon-new', true);

    requestSync('sign-in');
    await flush();

    expect(mockRepo.wipeAllSyncableData).not.toHaveBeenCalled();
    expect(state['sync.user_id']).toBe('anon-new');
    expect(state['sync.anonymous_user_id']).toBe('anon-new');
  });

  // An unsubscribed anonymous session has nothing to sync — no personal
  // entitlement, no teams — so it must not run the spaces probe and team
  // crawl on every foreground and every note write from mid-onboarding on.
  it('does not crawl for an unsubscribed anonymous session', async () => {
    const state = seedSyncState({});
    mockFetchUsage.mockResolvedValue({ isSubscribed: false } as never);
    signIn('anon-user', true);

    requestSync('sign-in');
    await flush();

    expect(mockSyncSpaces).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
    expect(state['sync.user_id']).toBe('anon-user');
  });
});

describe('syncEngine auth triggers', () => {
  /** Mirrors zustand: commit the new state, then notify subscribers with both states. */
  function emitAuthChange(next: MockAuthState): void {
    const prev = mockAuthState;
    setAuthState(next);
    authSubscriber?.(next, prev);
  }

  beforeEach(() => {
    seedSyncState({});
    setAuthState({ user: null, isGuest: false, sessionCookie: null });
    initSyncTriggers();
  });

  afterEach(() => {
    teardownSyncTriggers();
  });

  // Signing up from an anonymous session keeps `signed in` true throughout, so
  // an edge detector on that boolean misses the one transition the identity
  // reconciliation exists for.
  it('syncs when the user id changes from anonymous to real', async () => {
    emitAuthChange({
      user: { id: 'anon-user', isAnonymous: true },
      isGuest: false,
      sessionCookie: 'c',
    });
    await flush();
    mockBackfill.mockClear();

    emitAuthChange({
      user: { id: 'real-user', isAnonymous: false },
      isGuest: false,
      sessionCookie: 'c',
    });
    await flush();

    expect(mockBackfill).toHaveBeenCalledWith('real-user', expect.any(Function));
  });

  it('clears the link token when a real account signs out so the next account wipes', async () => {
    const state = seedSyncState({
      'sync.user_id': 'real-user',
      'sync.anonymous_user_id': 'anon-user',
    });

    emitAuthChange({
      user: { id: 'real-user', isAnonymous: false },
      isGuest: false,
      sessionCookie: 'c',
    });
    await flush();
    emitAuthChange({ user: null, isGuest: false, sessionCookie: null });

    expect(state['sync.anonymous_user_id']).toBeUndefined();
  });

  // Sign Out is the only account action an anonymous user is shown. The rows
  // on the device still belong to whoever holds it, so their eventual signup
  // has to stay a link — clearing the flag here would turn it into a wipe.
  it('keeps the link armed when an anonymous session signs out', async () => {
    const state = seedSyncState({
      'sync.user_id': 'anon-user',
      'sync.anonymous_user_id': 'anon-user',
    });

    emitAuthChange({
      user: { id: 'anon-user', isAnonymous: true },
      isGuest: false,
      sessionCookie: 'c',
    });
    await flush();
    emitAuthChange({ user: null, isGuest: false, sessionCookie: null });
    expect(state['sync.anonymous_user_id']).toBe('anon-user');

    emitAuthChange({
      user: { id: 'real-user', isAnonymous: false },
      isGuest: false,
      sessionCookie: 'c',
    });
    await flush();

    expect(mockRepo.wipeAllSyncableData).not.toHaveBeenCalled();
    expect(state['sync.user_id']).toBe('real-user');
  });
});
