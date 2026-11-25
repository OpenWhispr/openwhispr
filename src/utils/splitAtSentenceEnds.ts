// Whitespace after sentence-ending punctuation, allowing closing quotes or
// brackets in between. "3.5" has no whitespace after its point, so it holds.
const SENTENCE_BREAK = /(?<=[.!?…]["'”’)\]]*)\s+/u;
// A word ending a clause: a comma or semicolon, allowing closing quotes or brackets.
const CLAUSE_END = /[,;]["'”’)\]]*$/u;

export const wordsOf = (text: string): string[] => text.split(/\s+/u).filter(Boolean);

// A cleanup model reads a cut between words as a sentence end and writes a full
// stop and a capital there, so a long sentence is cut at the last comma or
// semicolon that keeps a run within the limit, and between words only where a
// run has none.
function cutLongSentence(words: string[], maxWords: number): string[] {
  const runs: string[] = [];
  let start = 0;
  while (words.length - start > maxWords) {
    let end = start + maxWords;
    while (end > start && !CLAUSE_END.test(words[end - 1])) end--;
    if (end === start) end = start + maxWords;
    runs.push(words.slice(start, end).join(" "));
    start = end;
  }
  runs.push(words.slice(start).join(" "));
  return runs;
}

/**
 * Cuts text into parts of at most `maxWords` words, breaking at sentence ends.
 * Text within the limit comes back whole and untouched. A single sentence over
 * the limit (speech-to-text often returns one long run) is cut at its commas or
 * semicolons, or between words where it has none in reach. Parts keep their
 * order and every word.
 */
export function splitAtSentenceEnds(text: string, maxWords: number): string[] {
  if (wordsOf(text).length <= maxWords) return [text];

  const parts: string[] = [];
  let sentences: string[] = [];
  let wordCount = 0;
  const flush = () => {
    if (sentences.length > 0) parts.push(sentences.join(" "));
    sentences = [];
    wordCount = 0;
  };

  for (const sentence of text.trim().split(SENTENCE_BREAK)) {
    const words = wordsOf(sentence);
    if (words.length > maxWords) {
      flush();
      parts.push(...cutLongSentence(words, maxWords));
      continue;
    }
    if (wordCount + words.length > maxWords) flush();
    sentences.push(sentence);
    wordCount += words.length;
  }
  flush();
  return parts;
}
