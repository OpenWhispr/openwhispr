const mockSyncState = new Map<string, string>();
jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: (key: string): string | null => mockSyncState.get(key) ?? null,
    setSyncState: (key: string, value: string): void => {
      mockSyncState.set(key, value);
    },
    clearSyncState: (key: string): void => {
      mockSyncState.delete(key);
    },
  },
}));

import {
  loadSharedDictionaryIfOwnedBy,
  useSharedDictionaryStore,
} from '../useSharedDictionaryStore';
import {
  saveSharedDictionaryState,
  SHARED_DICTIONARY_STATE_KEY,
  type SharedDictionaryState,
} from '@/sync/sharedDictionaryState';

const scope = (spaceId: string | null): SharedDictionaryState['scopes'][number] => ({
  space_id: spaceId,
  name: spaceId ?? 'Workspace',
  member_count: 2,
  word_count: 1,
});

const STATE: SharedDictionaryState = {
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  entries: {
    e1: { spaceId: null, word: 'Acme' },
    e2: { spaceId: 'space-1', word: 'Gizmo' },
    e3: { spaceId: 'space-1', word: 'Hidden' },
    e4: { spaceId: null, word: 'line\nbreak' },
  },
  hiddenIds: ['e3'],
  scopes: [scope(null), scope('space-1')],
  paused: false,
};

beforeEach(() => {
  mockSyncState.clear();
  useSharedDictionaryStore.getState().reset();
});

describe('useSharedDictionaryStore', () => {
  it('starts empty', () => {
    const { hints, sharedWordsLower, summary } = useSharedDictionaryStore.getState();
    expect(hints).toEqual({ space: [], workspace: [] });
    expect(sharedWordsLower.size).toBe(0);
    expect(summary).toBeNull();
  });

  it('loads the applying words and a summary from the stored state', async () => {
    await saveSharedDictionaryState(STATE);
    await useSharedDictionaryStore.getState().load();

    const { hints, sharedWordsLower, summary } = useSharedDictionaryStore.getState();
    expect(hints).toEqual({ space: ['Gizmo'], workspace: ['Acme'] });
    expect(summary).toEqual({ count: 2, workspaceName: 'Acme' });
    // Only the words that apply: a moved word whose shared copy the member hid
    // (or that isn't term-like) applies as a personal word, so Personal shows it.
    expect([...sharedWordsLower].sort()).toEqual(['acme', 'gizmo']);
  });

  it('applies nothing while paused, and keeps moved words in the personal list', async () => {
    await saveSharedDictionaryState({ ...STATE, paused: true });
    await useSharedDictionaryStore.getState().load();

    const { hints, sharedWordsLower, summary } = useSharedDictionaryStore.getState();
    expect(hints).toEqual({ space: [], workspace: [] });
    expect(summary).toBeNull();
    // A paused list stops applying at shared priority, but the moved words keep
    // applying as personal words, so the Personal list must still show them.
    expect(sharedWordsLower.size).toBe(0);
  });

  it('empties when the stored state is gone', async () => {
    await saveSharedDictionaryState(STATE);
    await useSharedDictionaryStore.getState().load();
    await saveSharedDictionaryState(null);
    await useSharedDictionaryStore.getState().load();

    const { hints, sharedWordsLower, summary } = useSharedDictionaryStore.getState();
    expect(hints).toEqual({ space: [], workspace: [] });
    expect(sharedWordsLower.size).toBe(0);
    expect(summary).toBeNull();
  });

  it('treats an unreadable stored state as none', async () => {
    mockSyncState.set(SHARED_DICTIONARY_STATE_KEY, '{not json');
    await useSharedDictionaryStore.getState().load();
    expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  });

  it('reset clears the words at once', async () => {
    await saveSharedDictionaryState(STATE);
    await useSharedDictionaryStore.getState().load();
    useSharedDictionaryStore.getState().reset();

    const { hints, sharedWordsLower, summary } = useSharedDictionaryStore.getState();
    expect(hints).toEqual({ space: [], workspace: [] });
    expect(sharedWordsLower.size).toBe(0);
    expect(summary).toBeNull();
  });

  it('a load that began before a reset does not bring the words back', async () => {
    await saveSharedDictionaryState(STATE);
    const loading = useSharedDictionaryStore.getState().load();
    useSharedDictionaryStore.getState().reset();
    await loading;

    expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  });
});

describe('loadSharedDictionaryIfOwnedBy', () => {
  beforeEach(async () => {
    await saveSharedDictionaryState(STATE);
    mockSyncState.set('sync.user_id', 'user-1');
  });

  it('loads the stored words for the account they were pulled under', async () => {
    await loadSharedDictionaryIfOwnedBy('user-1');
    expect(useSharedDictionaryStore.getState().hints).toEqual({
      space: ['Gizmo'],
      workspace: ['Acme'],
    });
  });

  it('stays empty for another account, even with a stored row', async () => {
    await loadSharedDictionaryIfOwnedBy('user-2');
    expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  });

  it('stays empty without a signed-in account', async () => {
    await loadSharedDictionaryIfOwnedBy(null);
    expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  });

  it('stays empty before any account has synced', async () => {
    mockSyncState.delete('sync.user_id');
    await loadSharedDictionaryIfOwnedBy('user-1');
    expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  });
});
