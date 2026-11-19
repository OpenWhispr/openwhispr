/** A run of the edited text: `changed` runs are drawn brand blue and underlined. */
export type DiffRun = { text: string; changed: boolean };

// Words and the whitespace between them, so spacing and line breaks survive the round trip.
const tokens = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
const isSpace = (token: string) => /^\s+$/.test(token);
// Compares words without case or the punctuation that rides on them ("Thanks," and "thanks" match),
// so a sentence the edit only re-punctuated doesn't light up.
const key = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Splits `after` into unchanged and changed runs against `before`, word by word (longest common
 * subsequence), so Practice 3 can show only the words the edit actually rewrote. Spaces between two
 * changed words are part of the change; spaces next to an unchanged word are not.
 */
export function diffWords(before: string, after: string): DiffRun[] {
  const a = tokens(before).filter((token) => !isSpace(token));
  const b = tokens(after);
  const words = b.map((token, index) => ({ token, index })).filter(({ token }) => !isSpace(token));
  // lcs[i][j]: the longest common run of a[i..] and words[j..].
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(words.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = words.length - 1; j >= 0; j--)
      lcs[i][j] =
        key(a[i]) === key(words[j].token) && key(a[i]) !== ''
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const kept = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < words.length) {
    if (key(a[i]) === key(words[j].token) && key(a[i]) !== '') {
      kept.add(words[j].index);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const changed = b.map((token, index) => (isSpace(token) ? null : !kept.has(index)));
  // A space is changed only between two changed words.
  for (let index = 0; index < b.length; index++) {
    if (changed[index] !== null) continue;
    const previous = changed
      .slice(0, index)
      .reverse()
      .find((value) => value !== null);
    const next = changed.slice(index + 1).find((value) => value !== null);
    changed[index] = Boolean(previous && next);
  }
  const runs: DiffRun[] = [];
  b.forEach((token, index) => {
    const flag = Boolean(changed[index]);
    const last = runs[runs.length - 1];
    if (last && last.changed === flag) last.text += token;
    else runs.push({ text: token, changed: flag });
  });
  return runs;
}
