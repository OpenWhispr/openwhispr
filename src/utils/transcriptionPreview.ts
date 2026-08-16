import type { InferenceMode } from "../types/electron";

export function supportsLiveTranscriptionPreview(
  mode: InferenceMode,
  selectedCloudModelStreams = false
): boolean {
  return mode === "local" || (mode === "providers" && selectedCloudModelStreams);
}

export function buildLiveTranscriptionPreview(committedText = "", partialText = ""): string {
  return [committedText.trim(), partialText.trim()].filter(Boolean).join(" ");
}

export function shouldShowByokStreamingPreview(
  enabled: boolean,
  cloudTranscriptionMode: string
): boolean {
  return enabled && cloudTranscriptionMode === "byok";
}
