/**
 * The assistant's name is no longer a transcription hint: saying it while dictating gives no
 * command, so the speech model has no reason to listen for it.
 */
import { buildDictationHints } from '@/lib/dictationHints';

jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));

let mockDictEntries: { word: string }[] = [];

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: mockDictEntries }) },
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: { defaultMode: 'cloud', dictationAgentEnabled: true, dictationAgentName: 'Aria' },
    }),
  },
}));

beforeEach(() => {
  mockDictEntries = [];
});

it('adds no assistant name to the hints', () => {
  expect(buildDictationHints(false)).not.toContain('Aria');
});

it('keeps a name the user put in the dictionary', () => {
  mockDictEntries = [{ word: 'Aria' }];
  expect(buildDictationHints(false)).toEqual(['Aria']);
});
