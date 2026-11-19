jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

import type { Note } from '@/data';
import { searchNotes, snippetAround } from '../search';

const note = (id: number, fields: Partial<Note>): Note =>
  ({
    id,
    title: '',
    content: '',
    enhancedContent: null,
    updatedAt: `2026-11-1${id} 10:00:00`,
    ...fields,
  }) as Note;

describe('searchNotes', () => {
  const transcripts: Record<number, string> = {
    3: 'Sam said that and after that the pricing call went long.',
  };
  const transcriptOf = jest.fn((value: Note) => transcripts[value.id] ?? '');
  const notes = [
    note(1, {
      title: 'Weekly sync',
      enhancedContent: '## Decisions\n- Ship the video before the pricing page.',
    }),
    note(2, { title: 'Pricing call', content: 'Sam sends the deck' }),
    note(3, { title: 'Ideas for the onboarding video' }),
    note(4, { title: 'Groceries', content: 'milk' }),
  ];

  beforeEach(() => transcriptOf.mockClear());

  it('finds titles, summaries and transcripts, best place first', () => {
    const hits = searchNotes(notes, 'pricing', transcriptOf);
    expect(hits.map((hit) => [hit.note.id, hit.place])).toEqual([
      [2, 'title'],
      [1, 'summary'],
      [3, 'transcript'],
    ]);
  });

  it('only reads a transcript when nothing else matched', () => {
    searchNotes(notes, 'pricing', transcriptOf);
    expect(transcriptOf.mock.calls.map(([value]) => value.id)).toEqual([3, 4]);
  });

  it('marks where the match sits in the snippet, without markdown', () => {
    const [, summary] = searchNotes(notes, 'PRICING', transcriptOf);
    expect(summary.snippet).toBe('…Ship the video before the pricing page.');
    expect(summary.snippet.slice(summary.start, summary.start + summary.length)).toBe('pricing');
  });

  it('returns nothing for a blank query', () => {
    expect(searchNotes(notes, '   ', transcriptOf)).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('cuts a long line around the match on a word boundary', () => {
    const text = `${'word '.repeat(30)}target ${'tail '.repeat(30)}`;
    const result = snippetAround(text, 'target');
    expect(result?.snippet.startsWith('…word')).toBe(true);
    expect(result?.snippet.endsWith('…')).toBe(true);
    expect(result?.snippet.slice(result.start, result.start + 6)).toBe('target');
  });
});
