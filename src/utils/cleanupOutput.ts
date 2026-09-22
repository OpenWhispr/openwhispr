import logger from "./logger";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;

function comparisonTokens(text: string): string[] {
  // Keep contractions as one word when punctuation is discarded.
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/\p{P}/gu, " ");
  return Array.from(wordSegmenter.segment(normalized))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

export function assertValidCleanupOutput(rawText: string, output: string): void {
  const originalTokens = comparisonTokens(rawText);
  const outputTokens = comparisonTokens(output);
  if (originalTokens.join(" ") === outputTokens.join(" ")) return;

  const tokens: string[] = [];
  const labelOffsets: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) {
      labelOffsets.push(tokens.length);
    } else {
      for (const token of comparisonTokens(line)) tokens.push(token);
    }
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return;
  // A label only explains a wrapper around the answer, never missing content
  // inside an otherwise similar sentence or after the duplicated answer.
  if (labelOffsets.some((offset) => offset !== 0 && offset !== halfLength)) return;
  if (!tokens.slice(0, halfLength).every((token, index) => token === tokens[index + halfLength])) {
    return;
  }

  const reason = "duplicated_transcript";
  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason,
    inputLength: rawText.length,
    outputLength: output.length,
  });
  throw Object.assign(
    new Error("AI cleanup repeated the transcript. The original text was kept."),
    {
      code: "CLEANUP_OUTPUT_INVALID",
      reason,
      messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
    }
  );
}
