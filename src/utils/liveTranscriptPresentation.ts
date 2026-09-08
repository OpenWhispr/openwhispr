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
