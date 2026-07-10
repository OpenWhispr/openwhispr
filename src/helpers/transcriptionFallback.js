// Where a streaming session's batch fallback goes. "skip" keeps a signed-out
// cloud user's audio from being diverted to a leftover BYOK provider.
export function resolveStreamingFallbackTarget({
  useLocalWhisper,
  cloudTranscriptionMode,
  isSignedIn,
}) {
  const isCloudMode = !useLocalWhisper && cloudTranscriptionMode === "openwhispr";
  if (isCloudMode) return isSignedIn ? "cloud" : "skip";
  return "byok";
}
