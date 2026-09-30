import { isRegenerableNoteTitle } from '../regenerableNoteTitle';

describe('isRegenerableNoteTitle', () => {
  it('treats an empty or blank title as unnamed', () => {
    expect(isRegenerableNoteTitle('')).toBe(true);
    expect(isRegenerableNoteTitle('   ')).toBe(true);
    expect(isRegenerableNoteTitle(null)).toBe(true);
  });

  it('treats the default titles a new note is born with as unnamed', () => {
    expect(isRegenerableNoteTitle('Untitled')).toBe(true);
    expect(isRegenerableNoteTitle('Untitled meeting')).toBe(true);
  });

  it('matches placeholders regardless of case and surrounding whitespace', () => {
    expect(isRegenerableNoteTitle('  UNTITLED  ')).toBe(true);
    expect(isRegenerableNoteTitle('untitled note')).toBe(true);
  });

  it('never regenerates a title the user typed', () => {
    expect(isRegenerableNoteTitle('Q3 planning')).toBe(false);
    expect(isRegenerableNoteTitle('Untitled thoughts on Q3')).toBe(false);
  });
});
