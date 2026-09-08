export interface ShimmerTranscriptParts {
  settled: string;
  active: string;
}

/**
 * Keep the newest phrase visually active without making the completed body
 * flicker. A short trailing phrase closely tracks the final wrapped line at
 * the panel's responsive width while remaining deterministic for testing.
 */
export function splitTranscriptForShimmer(
  text: string,
  activeWordCount = 6
): ShimmerTranscriptParts {
  const normalized = text.trim();
  if (!normalized) return { settled: "", active: "" };

  const wordLimit = Math.max(0, Math.floor(activeWordCount));
  if (wordLimit === 0) return { settled: normalized, active: "" };

  // Walk only the trailing phrase instead of splitting and rebuilding the
  // entire transcript on every realtime delta. Long sessions therefore keep
  // the same bounded presentation cost as short ones.
  let activeStart = normalized.length;
  let wordsFound = 0;
  while (activeStart > 0 && wordsFound < wordLimit) {
    while (activeStart > 0 && /\s/.test(normalized[activeStart - 1])) activeStart--;
    while (activeStart > 0 && !/\s/.test(normalized[activeStart - 1])) activeStart--;
    wordsFound++;
  }

  if (activeStart === 0) {
    return { settled: "", active: normalized };
  }

  return {
    settled: `${normalized.slice(0, activeStart).trimEnd()} `,
    active: normalized.slice(activeStart).trimStart(),
  };
}

export interface TailWord {
  index: number;
  text: string;
  active: boolean;
  /**
   * The exact whitespace that followed this word in the source — "" for the
   * last word. Rendered with the word so the tail reassembles the transcript
   * character for character.
   */
  separator: string;
}

/**
 * Opacity-only tail: the newest words sit at 62% and settle to 100% when
 * they leave the active window. Words stay individually rendered for a few
 * more positions so that settle can transition instead of stepping, and
 * their absolute index keeps each span stable across deltas.
 *
 * `activeWordCount: 0` is the commit: every word stays rendered at its same
 * index and simply stops being active, so the 62% -> 100% change is a real
 * transition rather than a remount at the new opacity.
 *
 * Splitting KEEPS the separators (fix round 1, finding 1). Splitting on
 * /\s+/ and re-joining with " " would flatten every line break, blank line
 * and bullet break — and the cleanup prompt (src/locales/en/prompts.json)
 * asks the model for exactly those, which is why the transcript paragraph is
 * `whitespace-pre-wrap` in the first place. It would also stop the visible
 * paragraph from matching the hidden node the panel measures its preferred
 * height against, which renders the same string raw.
 */
export function splitTranscriptForTail(
  text: string,
  { activeWordCount = 6, settlingWordCount = 6 } = {}
): { settled: string; tail: TailWord[] } {
  const normalized = text.trim();
  if (!normalized) return { settled: "", tail: [] };
  // Trimmed, so this always starts and ends on a word: even entries are
  // words, odd entries are the whitespace that followed them.
  const parts = normalized.split(/(\s+)/);
  const words = parts.filter((_, position) => position % 2 === 0);
  const tailStart = Math.max(0, words.length - activeWordCount - settlingWordCount);
  const activeStart = Math.max(0, words.length - activeWordCount);
  const tail = words.slice(tailStart).map((word, offset) => {
    const index = tailStart + offset;
    return {
      index,
      text: word,
      active: index >= activeStart,
      separator: parts[index * 2 + 1] ?? "",
    };
  });
  // A literal prefix of the source, separators intact — never a re-join.
  const settled = parts.slice(0, tailStart * 2).join("");
  return { settled, tail };
}
