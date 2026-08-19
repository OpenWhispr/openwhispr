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
