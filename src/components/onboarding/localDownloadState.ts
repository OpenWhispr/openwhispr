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

/**
 * Extraction is the last phase of a transfer, so the tray header only claims it
 * once every row has reached it — a mixed tray is still, truthfully, downloading.
 * A failed row is not one of those transfers: it has already stopped, so waiting
 * on it would keep the header describing a download that is no longer running.
 */
export function isTrayInstalling(
  downloads: readonly { installing?: boolean; error?: string }[]
): boolean {
  const running = downloads.filter((download) => !download.error);
  return running.length > 0 && running.every((download) => download.installing === true);
}

/** Cycles "" → "." → ".." → "..." so an installing header reads as live work. */
export function ellipsisFrame(tick: number): string {
  return ".".repeat(tick % 4);
}
