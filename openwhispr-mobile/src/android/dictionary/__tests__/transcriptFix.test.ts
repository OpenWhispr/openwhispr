const mockSegments = [
  {
    id: 1,
    createdAt: 'x',
    text: 'So the pilot with Sinty starts in March.',
    clientId: 'a',
    remoteId: 'r1',
  },
  {
    id: 2,
    createdAt: 'x',
    text: 'Great, I’ll ask sinty for the numbers. Sintyx stays.',
    clientId: 'b',
    remoteId: null,
  },
  { id: 3, createdAt: 'x', text: 'And the deck goes to Priya.', clientId: 'c', remoteId: null },
];
const mockReplace = jest.fn();
const mockSetState = jest.fn();
jest.mock('@/data', () => ({
  notesRepository: {
    getSegments: () => mockSegments,
    replaceSegments: (...args: unknown[]) => mockReplace(...args),
  },
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: { setState: (...args: unknown[]) => mockSetState(...args) },
}));
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));

import { countWord, fixWordInTranscript, replaceWord } from '../transcriptFix';

beforeEach(() => {
  mockReplace.mockClear();
  mockSetState.mockClear();
});

it('counts and replaces whole words only, in any case (C9)', () => {
  expect(countWord('Sinty, sinty and Sintyx', 'Sinty')).toBe(2);
  expect(replaceWord('Sinty, sinty and Sintyx', 'Sinty', 'Synty')).toBe('Synty, Synty and Sintyx');
  expect(countWord('anything', '  ')).toBe(0);
});

it('fixes every mention in the note and keeps each segment’s sync identity (C10)', () => {
  expect(fixWordInTranscript(9, 'Sinty', 'Synty')).toBe(2);
  const [noteId, next] = mockReplace.mock.calls[0];
  expect(noteId).toBe(9);
  expect(next.map((segment: { text: string }) => segment.text)).toEqual([
    'So the pilot with Synty starts in March.',
    'Great, I’ll ask Synty for the numbers. Sintyx stays.',
    'And the deck goes to Priya.',
  ]);
  expect(next[0]).toMatchObject({ clientId: 'a', remoteId: 'r1' });
  expect(next[0]).not.toHaveProperty('id');
  expect(mockSetState).toHaveBeenCalledTimes(1);
});

it('writes nothing when the word isn’t there', () => {
  expect(fixWordInTranscript(9, 'Qdrant', 'Quadrant')).toBe(0);
  expect(mockReplace).not.toHaveBeenCalled();
});
