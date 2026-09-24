const MIN_WORD_LENGTH = 3;
const MAX_DISTANCE_RATIO = 0.65;
const WORD_TOKEN_REGEX = /\p{L}[\p{L}'-]*/gu;

function tokenize(text: string): string[] {
  return text.match(WORD_TOKEN_REGEX) ?? [];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let prev = new Array(bl.length + 1);
  let curr = new Array(bl.length + 1);
  for (let j = 0; j <= bl.length; j++) prev[j] = j;

  for (let i = 1; i <= al.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl.length; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl.length];
}

export function extractCorrections(
  originalText: string,
  newText: string,
  existingDictionary: string[],
): string[] {
  if (!originalText || !newText || originalText === newText) return [];

  const originalWords = tokenize(originalText);
  const newWords = tokenize(newText);
  if (newWords.length === 0) return [];

  const originalLowerSet = new Set(originalWords.map((w) => w.toLowerCase()));
  const newLowerSet = new Set(newWords.map((w) => w.toLowerCase()));

  const removedWords = originalWords.filter((w) => !newLowerSet.has(w.toLowerCase()));
  const addedWords = newWords.filter((w) => !originalLowerSet.has(w.toLowerCase()));

  const dictLower = new Set(existingDictionary.map((w) => w.toLowerCase()));
  const seenLower = new Set<string>();
  const results: string[] = [];

  for (const candidate of addedWords) {
    if (candidate.length < MIN_WORD_LENGTH) continue;
    const lower = candidate.toLowerCase();
    if (dictLower.has(lower) || seenLower.has(lower)) continue;

    let best: { dist: number } | null = null;
    for (const removed of removedWords) {
      if (removed.length < MIN_WORD_LENGTH) continue;
      const dist = levenshtein(candidate, removed);
      const maxLen = Math.max(candidate.length, removed.length);
      if (maxLen === 0) continue;
      if (dist / maxLen < MAX_DISTANCE_RATIO && (!best || dist < best.dist)) {
        best = { dist };
      }
    }

    if (best) {
      results.push(candidate);
      seenLower.add(lower);
    }
  }

  return results;
}
