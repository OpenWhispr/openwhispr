const mockListeners: Record<string, (event: never) => void> = {};
const mockShowTab = jest.fn(() => Promise.resolve(true));
const mockLearn = jest.fn();
const mockUnlearn = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../../../../modules/android-dictation/src', () => ({
  AndroidDictation: { showLearnedTab: (...args: unknown[]) => mockShowTab(...(args as [])) },
  dictationEvents: {
    addListener: (name: string, listener: (event: never) => void) => {
      mockListeners[name] = listener;
      return { remove: () => delete mockListeners[name] };
    },
  },
}));
jest.mock('expo-router', () => ({ router: { navigate: (path: string) => mockNavigate(path) } }));
jest.mock('@/lib/dictationHints', () => ({ buildEffectiveDictionaryWords: () => ['OpenWhispr'] }));
jest.mock('../learned', () => ({
  loadLearnedWords: () => Promise.resolve(),
  learnCorrections: (...args: unknown[]) => mockLearn(...args),
  unlearn: (words: string[]) => mockUnlearn(words),
}));
jest.mock('../strings', () => ({
  dictionaryT: (key: string, options?: { word?: string; count?: number }) =>
    `${key}:${options?.word ?? options?.count ?? ''}`,
}));

import { observeFieldLearning } from '../fieldLearning';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const before = 'I’ll ask Sinty for the March numbers today.';
const after = 'I’ll ask Synty for the March numbers today.';

let stop: () => void;
beforeEach(() => {
  jest.clearAllMocks();
  stop = observeFieldLearning();
});
afterEach(() => stop());

it('learns a word fixed after dictating and shows the bubble’s tab (C11)', async () => {
  mockLearn.mockReturnValueOnce(['Synty']);
  mockListeners.onFieldEdited({ before, after } as never);
  await flush();
  expect(mockLearn).toHaveBeenCalledWith([{ word: 'Synty', from: 'Sinty' }], { kind: 'app' });
  expect(mockShowTab).toHaveBeenCalledWith({
    words: ['Synty'],
    message: 'learnedToast:Synty',
    undo: 'undo:',
    undone: 'wontLearn:Synty',
  });
});

it('a second learn while the tab is out updates it in place', async () => {
  mockLearn.mockReturnValueOnce(['Synty']).mockReturnValueOnce(['Qdrant']);
  mockListeners.onFieldEdited({ before, after } as never);
  await flush();
  mockListeners.onFieldEdited({
    before: 'Ask about Quadrant pricing today.',
    after: 'Ask about Qdrant pricing today.',
  } as never);
  await flush();
  expect(mockShowTab).toHaveBeenLastCalledWith(
    expect.objectContaining({ words: ['Synty', 'Qdrant'], message: 'learnedManyToast:2' }),
  );
});

it('typing more after the dictation teaches nothing and shows nothing', async () => {
  mockListeners.onFieldEdited({ before, after: `${before} See you there.` } as never);
  await flush();
  expect(mockLearn).not.toHaveBeenCalled();
  expect(mockShowTab).not.toHaveBeenCalled();
});

it('Undo on the tab unlearns the words', async () => {
  mockListeners.onLearnedUndo({ words: ['Synty'] } as never);
  await flush();
  expect(mockUnlearn).toHaveBeenCalledWith(['Synty']);
});
