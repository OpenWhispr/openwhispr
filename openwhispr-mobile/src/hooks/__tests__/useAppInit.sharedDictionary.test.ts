import { renderHook, waitFor } from '@testing-library/react-native';

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

jest.mock('@/lib/meetingRecovery', () => ({ startMeetingRecoveryOnce: jest.fn() }));

// Selector-style store mocks for everything else useAppInit hydrates.
function mockSelectorStore<T extends object>(state: T): unknown {
  return Object.assign((selector: (value: T) => unknown) => selector(state), {
    getState: () => state,
  });
}
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: mockSelectorStore({ load: jest.fn(), isLoaded: true }),
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: mockSelectorStore({ load: jest.fn(), isLoaded: true }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: mockSelectorStore({ initialize: jest.fn(), isInitialized: false }),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: mockSelectorStore({ loadConfig: jest.fn() }),
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: mockSelectorStore({ loadTranscripts: jest.fn() }),
}));

// The real auth store pulls in better-auth, which ships ESM jest doesn't transform.
const mockAuthState: { user: { id: string } | null; isGuest: boolean } = {
  user: null,
  isGuest: false,
};
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
    { getState: () => mockAuthState },
  ),
}));

import { useAppInit } from '../useAppInit';
import { useSharedDictionaryStore } from '@/store/useSharedDictionaryStore';

const STORED_STATE = JSON.stringify({
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  entries: { e1: { spaceId: null, word: 'Acme' } },
  hiddenIds: [],
  scopes: [{ space_id: null, name: 'Acme', member_count: 2, word_count: 1 }],
  paused: false,
});

beforeEach(() => {
  mockSyncState.clear();
  mockSyncState.set('shared_dictionary.state', STORED_STATE);
  mockSyncState.set('sync.user_id', 'user-1');
  mockAuthState.user = null;
  mockAuthState.isGuest = false;
  useSharedDictionaryStore.getState().reset();
});

// Lets a load that was (or wasn't) started settle before asserting it didn't fill.
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('useAppInit shared dictionary hydration', () => {
  it('loads the stored shared words for the account they belong to', async () => {
    mockAuthState.user = { id: 'user-1' };

    renderHook(() => useAppInit());

    await waitFor(() =>
      expect(useSharedDictionaryStore.getState().hints.workspace).toEqual(['Acme']),
    );
  });

  it('stays empty for a guest', async () => {
    mockAuthState.user = { id: 'user-1' };
    mockAuthState.isGuest = true;

    renderHook(() => useAppInit());
    await settle();

    expect(useSharedDictionaryStore.getState().hints.workspace).toEqual([]);
  });

  it('stays empty while signed out', async () => {
    renderHook(() => useAppInit());
    await settle();

    expect(useSharedDictionaryStore.getState().hints.workspace).toEqual([]);
  });

  it('stays empty for a different account, even with a stored row', async () => {
    mockAuthState.user = { id: 'user-2' };

    renderHook(() => useAppInit());
    await settle();

    expect(useSharedDictionaryStore.getState().hints.workspace).toEqual([]);
  });
});
