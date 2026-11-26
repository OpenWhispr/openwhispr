import type { DictionaryEntry } from '@/android/store/useDictionaryStore';
import type { Snippet } from '@/android/dictation/snippets';

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++)
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = curr;
  }
  return prev[b.length];
}

export type WordSearch = {
  /** A word spelled exactly as typed (any case): no Add row then. */
  exact: DictionaryEntry | null;
  /** Words containing the query or a near spelling of it, closest first. */
  matches: DictionaryEntry[];
};

/**
 * C5: what the search shows. "Synty" finds "Synthesia" (contains) and "Sintra" (near), so
 * someone checking a spelling sees what is close to it.
 */
export function searchWords(entries: DictionaryEntry[], query: string): WordSearch {
  const q = query.trim().toLowerCase();
  if (!q) return { exact: null, matches: [] };
  const exact = entries.find((entry) => entry.word.toLowerCase() === q) ?? null;
  const scored: { entry: DictionaryEntry; score: number }[] = [];
  for (const entry of entries) {
    if (entry === exact) continue;
    const word = entry.word.toLowerCase();
    if (word.includes(q)) {
      scored.push({ entry, score: word.startsWith(q) ? 0 : 1 });
      continue;
    }
    // Compare against the start of the word, so a short query can match a longer word.
    const head = word.slice(0, Math.max(q.length, 3));
    const near = distance(head, q);
    if (q.length >= 3 && near <= Math.max(1, Math.floor(q.length * 0.4)))
      scored.push({ entry, score: 2 + near });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.word.localeCompare(b.entry.word));
  return { exact, matches: scored.map((item) => item.entry) };
}

export function searchSnippets(snippets: Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return snippets;
  return snippets.filter(
    (snippet) =>
      snippet.trigger.toLowerCase().includes(q) || snippet.replacement.toLowerCase().includes(q),
  );
}

/** "Your words": newest first; words with no date (old rows) after, A to Z. */
export function sortWords(entries: DictionaryEntry[]): DictionaryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.addedAt != null && b.addedAt != null) return b.addedAt - a.addedAt;
    if (a.addedAt != null) return -1;
    if (b.addedAt != null) return 1;
    return a.word.localeCompare(b.word, undefined, { sensitivity: 'base' });
  });
}

/** The comma list split into words, without empties or repeats (case-insensitive). */
export function splitWords(input: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of input.split(',')) {
    const word = raw.trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}
