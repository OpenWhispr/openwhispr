// Where a streaming session's batch fallback goes. "skip" keeps a signed-out
// cloud user's audio from being diverted to a leftover BYOK provider.
export function resolveStreamingFallbackTarget(params = {}) {
  const { useLocalWhisper, cloudTranscriptionMode, isSignedIn } = params || {};
  const normMode =
    typeof cloudTranscriptionMode === "string" ? cloudTranscriptionMode.trim().toLowerCase() : "";
  const isCloudMode = !useLocalWhisper && normMode === "openwhispr";
  if (isCloudMode) return isSignedIn ? "cloud" : "skip";
  return "byok";
}
