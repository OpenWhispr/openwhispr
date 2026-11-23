/** Finding a transcript word from where a finger pressed, without a tappable span per word. */
const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;

export type TextLine = { text: string; x: number; y: number; width: number; height: number };

// Rough glyph widths, relative to an average letter, for finding a word inside one line.
function glyphWidth(character: string): number {
  if (character === ' ') return 0.5;
  if ("iljI.,;:'’!|".includes(character)) return 0.45;
  if ('frt()'.includes(character)) return 0.65;
  if ('mwMW'.includes(character)) return 1.5;
  if (character !== character.toLowerCase()) return 1.25;
  return 1;
}

/**
 * The word under a point of laid-out text, from `onTextLayout`'s lines: the line under the
 * finger, then the character along that line, spread by glyph width over the line's own width,
 * so an estimate never drifts past the end of a line. A point between words takes the nearer.
 */
export function wordAtPoint(lines: TextLine[], x: number, y: number): string | null {
  if (!lines.length) return null;
  const line =
    lines.find((item) => y >= item.y && y < item.y + item.height) ??
    (y < lines[0].y ? lines[0] : lines[lines.length - 1]);
  const text = line.text.replace(/\s+$/, '');
  if (!text) return null;
  const widths = [...text].map(glyphWidth);
  const total = widths.reduce((sum, width) => sum + width, 0);
  const target = ((x - line.x) / Math.max(1, line.width)) * total;
  let index = 0;
  for (let run = 0; index < widths.length - 1 && run + widths[index] <= target; index++)
    run += widths[index];
  let best: { word: string; distance: number } | null = null;
  const characters = [...text];
  const joined = characters.join('');
  for (const match of joined.matchAll(WORD)) {
    const first = [...joined.slice(0, match.index)].length;
    const last = first + [...match[0]].length - 1;
    const distance = index < first ? first - index : index > last ? index - last : 0;
    if (!best || distance < best.distance) best = { word: match[0], distance };
  }
  return best?.word ?? null;
}
