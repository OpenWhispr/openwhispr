interface PersistResult<T> {
  success: boolean;
  transcription?: T;
  error?: string;
}

interface ReprocessTranscriptOptions<T> {
  rawText: string | null;
  process: (rawText: string) => Promise<string | null | undefined>;
  persist: (processedText: string, rawText: string) => Promise<PersistResult<T>>;
}

/**
 * Re-runs cleanup without touching the stored row until both reasoning and the
 * database write succeed. The original text is intentionally passed through
 * byte-for-byte so history remains a reliable recovery source.
 */
export async function reprocessTranscript<T>({
  rawText,
  process,
  persist,
}: ReprocessTranscriptOptions<T>): Promise<T> {
  if (!rawText?.trim()) {
    throw new Error("The raw transcript is unavailable");
  }

  const processedText = await process(rawText);
  if (!processedText?.trim()) {
    throw new Error("Cleanup returned an empty transcript");
  }

  const result = await persist(processedText, rawText);
  if (!result.success || !result.transcription) {
    throw new Error(result.error || "The updated transcript could not be saved");
  }

  return result.transcription;
}
