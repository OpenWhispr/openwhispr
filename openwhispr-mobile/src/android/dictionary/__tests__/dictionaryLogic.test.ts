import type { DictionaryEntry } from '@/store/useDictionaryStore';
import { extractCorrections } from '@/lib/correctionLearner';
import { extractCorrectionPairs } from '../correctionPairs';
import { searchWords, sortWords, splitWords } from '../search';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'account-1' } }) },
}));
jest.mock('@/store/useDictionaryStore', () => {
  const { create } = require('zustand') as typeof import('zustand');
  const store = create<{
    entries: DictionaryEntry[];
    addLearnedWords: (words: string[]) => void;
    removeWord: (word: string) => void;
  }>((set, get) => ({
    entries: [],
    addLearnedWords: (words) =>
      set({
        entries: [
          ...get().entries,
          ...words.map((word) => ({
            word,
            source: 'learned' as const,
            addedAt: 1,
            sharedAt: null,
          })),
        ],
      }),
    removeWord: (word) =>
      set({
        entries: get().entries.filter((entry) => entry.word.toLowerCase() !== word.toLowerCase()),
      }),
  }));
  return { useDictionaryStore: store };
});

import { useDictionaryStore } from '@/store/useDictionaryStore';
import {
  accountLearned,
  keepLearned,
  learnCorrections,
  renameLearned,
  relearn,
  restoreLearned,
  reviewQueue,
  unlearn,
  useLearnedWords,
} from '../learned';

const word = (value: string, fields: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  word: value,
  source: 'manual',
  addedAt: null,
  sharedAt: null,
  ...fields,
});

const note = { kind: 'note' as const, noteId: 7, title: 'Pitch prep with Synty' };
const state = () => accountLearned(useLearnedWords.getState().saved);

beforeEach(() => {
  useDictionaryStore.setState({ entries: [] });
  useLearnedWords.setState({ saved: {}, loaded: true });
});

describe('search (C5)', () => {
  const entries = [word('Synthesia'), word('Sintra'), word('Kubernetes')];

  it('offers close spellings and no exact match for a new word', () => {
    const result = searchWords(entries, 'Synty');
    expect(result.exact).toBeNull();
    expect(result.matches.map((entry) => entry.word)).toEqual(['Synthesia', 'Sintra']);
  });

  it('finds the exact word in any case, so there is nothing to add', () => {
    const result = searchWords(entries, 'kubernetes');
    expect(result.exact?.word).toBe('Kubernetes');
  });

  it('shows nothing for an empty query', () => {
    expect(searchWords(entries, '  ')).toEqual({ exact: null, matches: [] });
  });
});

describe('the list and the add sheet', () => {
  it('lists newest first, then undated words A to Z', () => {
    const sorted = sortWords([
      word('zeta'),
      word('Old', { addedAt: 10 }),
      word('alpha'),
      word('New', { addedAt: 20 }),
    ]);
    expect(sorted.map((entry) => entry.word)).toEqual(['New', 'Old', 'alpha', 'zeta']);
  });

  it('splits a comma list into words without empties or repeats (C2)', () => {
    expect(splitWords('Synty, Qdrant,, synty , Priya Shah,')).toEqual([
      'Synty',
      'Qdrant',
      'Priya Shah',
    ]);
  });
});

describe('learning from fixes', () => {
  it('knows which misheard word a correction replaced, and still returns the same words', () => {
    const before = 'Call Sinty on Friday about the pilot.';
    const after = 'Call Synty on Friday about the pilot.';
    expect(extractCorrectionPairs(before, after, [])).toEqual([{ word: 'Synty', from: 'Sinty' }]);
    expect(extractCorrections(before, after, [])).toEqual(['Synty']);
  });

  it('learns a fix, records where it came from and puts it up for review (C1)', () => {
    expect(learnCorrections([{ word: 'Synty', from: 'Sinty' }], note)).toEqual(['Synty']);
    const entries = useDictionaryStore.getState().entries;
    expect(entries.map((entry) => entry.word)).toEqual(['Synty']);
    const queue = reviewQueue(entries, state());
    expect(queue).toHaveLength(1);
    expect(queue[0].info).toMatchObject({ from: 'Sinty', origin: note, keptAt: null });
  });

  it('never learns a word already in the dictionary', () => {
    useDictionaryStore.setState({ entries: [word('Synty')] });
    expect(learnCorrections([{ word: 'synty', from: 'Sinty' }], note)).toEqual([]);
  });

  it('Undo removes the word and never learns that fix again (C7)', () => {
    learnCorrections([{ word: 'Synty', from: 'Sinty' }], note);
    unlearn(['Synty']);
    expect(useDictionaryStore.getState().entries).toEqual([]);
    expect(learnCorrections([{ word: 'Synty', from: 'Sinty' }], note)).toEqual([]);
  });

  it('Keep takes a word out of review; Remove can be undone with its history', () => {
    learnCorrections(
      [
        { word: 'Synty', from: 'Sinty' },
        { word: 'Qdrant', from: 'Quadrant' },
      ],
      { kind: 'app' },
    );
    keepLearned('Synty');
    let queue = reviewQueue(useDictionaryStore.getState().entries, state());
    expect(queue.map((item) => item.word)).toEqual(['Qdrant']);

    const info = queue[0].info;
    unlearn(['Qdrant']);
    expect(reviewQueue(useDictionaryStore.getState().entries, state())).toEqual([]);
    restoreLearned('Qdrant', info);
    queue = reviewQueue(useDictionaryStore.getState().entries, state());
    expect(queue.map((item) => item.word)).toEqual(['Qdrant']);
  });

  it('an edit carries the history to the new spelling and counts as keeping it (C3)', () => {
    learnCorrections([{ word: 'Synty', from: 'Sinty' }], note);
    renameLearned('Synty', 'Synty Labs');
    expect(state().learned['synty']).toBeUndefined();
    expect(state().learned['synty labs']).toMatchObject({ from: 'Sinty', origin: note });
    expect(state().learned['synty labs'].keptAt).not.toBeNull();
  });

  it('keeps each account’s learned words apart', () => {
    learnCorrections([{ word: 'Synty', from: 'Sinty' }], note);
    expect(Object.keys(useLearnedWords.getState().saved)).toEqual(['account-1']);
  });

  it('leaves words learned on another phone out of review', () => {
    const entries = [word('Parakeet', { source: 'learned', addedAt: 5 })];
    expect(reviewQueue(entries, state())).toEqual([]);
  });
});

it('an Undo can be undone: the word is allowed and learned again', () => {
  learnCorrections([{ word: 'Synty', from: 'Sinty' }], { kind: 'app' });
  unlearn(['Synty']);
  expect(relearn(['Synty'], { kind: 'app' })).toEqual(['Synty']);
  expect(useDictionaryStore.getState().entries.map((entry) => entry.word)).toEqual(['Synty']);
});
