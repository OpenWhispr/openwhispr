import { wordAtPoint, type TextLine } from '../wordAtPoint';

const lines: TextLine[] = [
  { text: 'Welcome back to the show. ', x: 0, y: 0, width: 250, height: 23 },
  { text: 'Today we’re talking', x: 0, y: 23, width: 190, height: 23 },
];

describe('wordAtPoint', () => {
  it('finds the word under the finger on the right line', () => {
    expect(wordAtPoint(lines, 5, 10)).toBe('Welcome');
    expect(wordAtPoint(lines, 240, 10)).toBe('show');
    expect(wordAtPoint(lines, 5, 30)).toBe('Today');
    expect(wordAtPoint(lines, 185, 30)).toBe('talking');
  });

  it('keeps apostrophes inside a word', () => {
    expect(wordAtPoint(lines, 85, 30)).toBe('we’re');
  });

  it('takes the nearer word for a point past the text, and nothing without a layout', () => {
    expect(wordAtPoint(lines, 400, 60)).toBe('talking');
    expect(wordAtPoint([], 10, 10)).toBeNull();
  });
});
