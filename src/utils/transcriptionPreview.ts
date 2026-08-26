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

/**
 * Assistant-routed recordings stream their answer into the assistant panel;
 * the floating dictation preview must never appear for them. Single owner of
 * that rule for both the local preview window (AudioManager's `display` flag)
 * and the BYOK streaming preview below.
 */
export function shouldDisplayDictationPreview(
  enabled: boolean,
  voiceAgentRequested: boolean
): boolean {
  return !!enabled && !voiceAgentRequested;
}

export function shouldShowByokStreamingPreview(
  enabled: boolean,
  cloudTranscriptionMode: string,
  voiceAgentRequested = false
): boolean {
  return (
    shouldDisplayDictationPreview(enabled, voiceAgentRequested) && cloudTranscriptionMode === "byok"
  );
}
