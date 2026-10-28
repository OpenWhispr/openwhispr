/**
 * Shared dictionary words in the hint lists: ranked below the user's own words,
 * deduped against them, and bounded wherever they reach an LLM prompt.
 */
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

let mockDictWords: string[] = [];
let mockMovedWords: string[] = [];
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: {
    getState: () => ({
      isLoaded: true,
      entries: [
        ...mockDictWords.map((word) => ({ word, sharedAt: null })),
        ...mockMovedWords.map((word) => ({ word, sharedAt: 1 })),
      ],
    }),
  },
}));
let mockSnippets: { trigger: string; replacement: string }[] = [];
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: mockSnippets }) },
}));

// cleanupTranscript's collaborators, for the request it sends.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async (req: { text: string }) => ({ text: req.text, model: 'm' })),
  },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cleanupEnabled: true, defaultMode: 'cloud' } }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));

import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { cleanupTranscript } from '../cleanupTranscript';
import { extractCorrections } from '../correctionLearner';
import {
  buildDictationHints,
  buildDictationHintTiers,
  buildEffectiveDictionaryWords,
  buildLlmDictionary,
} from '../dictationHints';
import { useSharedDictionaryStore } from '@/store/useSharedDictionaryStore';
import {
  saveSharedDictionaryState,
  type SharedDictionaryState,
} from '@/sync/sharedDictionaryState';

const scope = (spaceId: string | null): SharedDictionaryState['scopes'][number] => ({
  space_id: spaceId,
  name: spaceId ?? 'Workspace',
  member_count: 2,
  word_count: 1,
});

async function loadShared(overrides: Partial<SharedDictionaryState>): Promise<void> {
  await saveSharedDictionaryState({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    entries: {},
    hiddenIds: [],
    scopes: [scope(null), scope('space-1')],
    paused: false,
    ...overrides,
  });
  await useSharedDictionaryStore.getState().load();
}

function workspaceEntries(words: string[]): SharedDictionaryState['entries'] {
  return Object.fromEntries(
    words.map((word, i) => [`w${i}`, { spaceId: null, word }]),
  ) as SharedDictionaryState['entries'];
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  mockSyncState.clear();
  mockDictWords = [];
  mockMovedWords = [];
  mockSnippets = [];
  useSharedDictionaryStore.getState().reset();
  jest.clearAllMocks();
  // cleanupTranscript logs its timing; keep the test output quiet.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('buildDictationHints with shared words', () => {
  it('puts personal before space before workspace', async () => {
    mockDictWords = ['Piha'];
    mockSnippets = [{ trigger: 'sig', replacement: 'Best, Chad' }];
    await loadShared({
      entries: {
        a: { spaceId: null, word: 'Workspace1' },
        b: { spaceId: 'space-1', word: 'Space1' },
      },
    });
    expect(buildDictationHintTiers(true)).toEqual([['Piha', 'sig'], ['Space1'], ['Workspace1']]);
    expect(buildDictationHints(true)).toEqual(['Piha', 'sig', 'Space1', 'Workspace1']);
    expect(buildDictationHints(false)).toEqual(['Piha', 'Space1', 'Workspace1']);
  });

  it('dedupe keeps personal spelling', async () => {
    mockDictWords = ['OpenWhispr'];
    await loadShared({ entries: { a: { spaceId: null, word: 'openwhispr' } } });
    expect(buildDictationHints(false)).toEqual(['OpenWhispr']);
  });

  it('hidden and paused words are excluded', async () => {
    await loadShared({
      entries: {
        a: { spaceId: null, word: 'Visible' },
        b: { spaceId: 'space-1', word: 'Hidden' },
      },
      hiddenIds: ['b'],
    });
    expect(buildDictationHints(false)).toEqual(['Visible']);

    await loadShared({ entries: { a: { spaceId: null, word: 'Visible' } }, paused: true });
    expect(buildDictationHints(false)).toEqual([]);
  });

  it('a newline/65-char/<tag> shared word never reaches hints', async () => {
    const unsafe = ['line\nbreak', 'x'.repeat(65), '<system>'];
    await loadShared({ entries: workspaceEntries([...unsafe, 'Safe']) });
    expect(buildDictationHints(true)).toEqual(['Safe']);
    expect(buildLlmDictionary(true)).toEqual({ personal: [], shared: ['Safe'] });
  });
});

describe('buildLlmDictionary limits', () => {
  it('keeps every personal word and trigger, then at most 200 shared, space first', async () => {
    mockDictWords = Array.from({ length: 250 }, (_, i) => `mine${i}`);
    mockSnippets = [{ trigger: 'sig', replacement: 'Best, Chad' }];
    await loadShared({
      entries: {
        ...workspaceEntries(Array.from({ length: 300 }, (_, i) => `team${i}`)),
        s1: { spaceId: 'space-1', word: 'SpaceWord' },
      },
    });
    const { personal, shared } = buildLlmDictionary(true);
    expect(personal).toEqual([...mockDictWords, 'sig']);
    expect(shared[0]).toBe('SpaceWord');
    expect(shared).toHaveLength(200);
    expect(buildLlmDictionary(false).personal).not.toContain('sig');
  });
});

describe('cleanupTranscript', () => {
  it('keeps personal words in customDictionary and at most 200 shared ones apart', async () => {
    mockDictWords = ['Piha', 'Biscuit'];
    await loadShared({
      entries: workspaceEntries(Array.from({ length: 300 }, (_, i) => `team${i}`)),
    });
    await cleanupTranscript('some text', { context: 'keyboard' });
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0] as {
      customDictionary: string[];
      sharedDictionary: string[];
    };
    expect(request.customDictionary).toEqual(['Piha', 'Biscuit']);
    expect(request.sharedDictionary).toEqual(Array.from({ length: 200 }, (_, i) => `team${i}`));
  });

  it('sends no sharedDictionary for a personal-only dictionary', async () => {
    mockDictWords = ['Piha'];
    await cleanupTranscript('some text', { context: 'keyboard' });
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.customDictionary).toEqual(['Piha']);
    expect(request).not.toHaveProperty('sharedDictionary');
  });
});

describe('correction learning', () => {
  it('extractCorrections receives shared words', async () => {
    mockDictWords = ['Piha'];
    mockSnippets = [{ trigger: 'sig', replacement: 'Best, Chad' }];
    await loadShared({ entries: { a: { spaceId: null, word: 'Kubernetes' } } });
    const words = buildEffectiveDictionaryWords();
    expect(words).toEqual(['Piha', 'Kubernetes']);
    // A correction to a word the team list already spells is not learned into Personal.
    expect(extractCorrections('deploy to kubernetis', 'deploy to Kubernetes', words)).toEqual([]);
  });
});

describe('buildLlmDictionary', () => {
  it('keeps personal words and triggers apart from the shared ones', async () => {
    mockDictWords = ['Piha'];
    mockSnippets = [{ trigger: 'sig', replacement: 'Best, Chad' }];
    await loadShared({ entries: workspaceEntries(['Acme']) });
    expect(buildLlmDictionary(true)).toEqual({ personal: ['Piha', 'sig'], shared: ['Acme'] });
  });
});

// The server keeps a moved word's personal fallback alive while any readable
// workspace still applies it, so hiding the shared copy must stop it here.
describe('moved words whose shared copy the member hid', () => {
  it('stop applying', async () => {
    mockDictWords = ['Kubernetes'];
    mockMovedWords = ['Grafana'];
    await loadShared({ entries: { g: { spaceId: null, word: 'Grafana' } }, hiddenIds: ['g'] });
    expect(buildDictationHintTiers(false)[0]).toEqual(['Kubernetes']);
    expect(buildDictationHints(false)).toEqual(['Kubernetes']);
  });

  it('match the hidden copy by NFC and case', async () => {
    mockMovedWords = ['Cafe\u0301'];
    await loadShared({ entries: { c: { spaceId: null, word: 'CAFÉ' } }, hiddenIds: ['c'] });
    expect(buildDictationHints(false)).toEqual([]);
  });

  it('still apply while another copy applies', async () => {
    mockMovedWords = ['Grafana'];
    await loadShared({
      entries: {
        g: { spaceId: null, word: 'Grafana' },
        s: { spaceId: 'space-1', word: 'grafana' },
      },
      hiddenIds: ['g'],
    });
    expect(buildDictationHints(false)).toEqual(['Grafana']);
  });

  it('never affect a personal word that was not moved', async () => {
    mockDictWords = ['Grafana'];
    await loadShared({ entries: { g: { spaceId: null, word: 'Grafana' } }, hiddenIds: ['g'] });
    expect(buildDictationHints(false)).toEqual(['Grafana']);
  });

  it('apply as before with no hides', async () => {
    mockMovedWords = ['Grafana'];
    expect(buildDictationHints(false)).toEqual(['Grafana']);
  });
});
