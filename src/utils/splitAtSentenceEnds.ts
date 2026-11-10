// Whitespace after sentence-ending punctuation, allowing closing quotes or
// brackets in between. "3.5" has no whitespace after its point, so it holds.
const SENTENCE_BREAK = /(?<=[.!?…]["'”’)\]]*)\s+/u;

const wordsOf = (text: string): string[] => text.split(/\s+/u).filter(Boolean);

/**
 * Cuts text into parts of at most `maxWords` words, breaking at sentence ends.
 * Text within the limit comes back whole and untouched. A single sentence over
 * the limit (speech-to-text often returns one unpunctuated run) is cut between
 * words. Parts keep their order and every word.
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
      for (let start = 0; start < words.length; start += maxWords) {
        parts.push(words.slice(start, start + maxWords).join(" "));
      }
      continue;
    }
    if (wordCount + words.length > maxWords) flush();
    sentences.push(sentence);
    wordCount += words.length;
  }
  flush();
  return parts;
}
