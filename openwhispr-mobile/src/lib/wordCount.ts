// The shared word counter, version 2: a port of countSpokenWords in the
// desktop app (src/helpers/analytics.js) and countAnalyticsWords in the API
// (lib/analytics.ts). One fixture checks all three; keep them alike.
export const WORD_COUNTER_VERSION = 2;

const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The words in a transcript, or null when they can't be counted the shared
 * way: Chinese, Japanese and Korean need Intl.Segmenter, which Hermes lacks,
 * and splitting them on spaces gives a different number rather than a rougher
 * one.
 */
export function countSpokenWords(text: string): number | null {
  const trimmed = text.trim();
  const fallbackCount = trimmed ? trimmed.split(/\s+/).length : 0;
  if (fallbackCount === 0 || !CJK_SCRIPT_PATTERN.test(text)) return fallbackCount;
  try {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
    const segmentedCount = Array.from(segmenter.segment(text)).filter(
      (segment) => segment.isWordLike,
    ).length;
    return segmentedCount || fallbackCount;
  } catch {
    return null;
  }
}
