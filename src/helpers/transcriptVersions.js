/**
 * Keeps the original transcription stable while reasoning updates the text
 * that will be pasted. This is deliberately value-based so fallback paths
 * cannot accidentally overwrite the recovery copy.
 */
export function createTranscriptVersions(rawText = "") {
  return { rawText, text: rawText };
}

export function applyProcessedTranscript(versions, processedText) {
  if (!processedText) return versions;
  return { ...versions, text: processedText };
}

export function replaceWithTranscriptionResult(versions, result) {
  if (!result?.text) return versions;
  return {
    text: result.text,
    rawText: result.rawText ?? result.text,
  };
}
