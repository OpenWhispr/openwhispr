export interface LocalDownloadActivity {
  whisper: boolean;
  parakeet: boolean;
  llm: boolean;
}

/** A transcription transfer must never unlock the separate assistant stage. */
export function isLocalStageDownloadActive(
  stage: "dictation" | "assistant",
  activity: LocalDownloadActivity
): boolean {
  return stage === "assistant" ? activity.llm : activity.whisper || activity.parakeet;
}

/**
 * Live terminal events may arrive while the initial inventory snapshot is still
 * loading. Never let that older snapshot restore a row the live stream removed.
 * Current live state wins for every other key as well.
 */
export function mergeHydratedDownloads<T>(
  discovered: Record<string, T>,
  current: Record<string, T>,
  removedDuringHydration: ReadonlySet<string>
): Record<string, T> {
  const recoverable = Object.fromEntries(
    Object.entries(discovered).filter(([key]) => !removedDuringHydration.has(key))
  ) as Record<string, T>;
  return { ...recoverable, ...current };
}
