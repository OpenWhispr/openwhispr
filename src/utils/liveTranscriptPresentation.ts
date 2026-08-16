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
  activeWordCount = 12
): ShimmerTranscriptParts {
  const normalized = text.trim();
  if (!normalized) return { settled: "", active: "" };

  const words = normalized.split(/\s+/);
  if (words.length <= activeWordCount) {
    return { settled: "", active: normalized };
  }

  return {
    settled: words.slice(0, -activeWordCount).join(" ") + " ",
    active: words.slice(-activeWordCount).join(" "),
  };
}
