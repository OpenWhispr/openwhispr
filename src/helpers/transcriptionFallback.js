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

// Session failures batch can absorb: the rollout was turned off for this
// account, its mint window is exhausted, or the session service is down.
// Denials the user has to act on (auth, policy, quota, upgrade) keep
// surfacing. Scoped to the managed Orukeet route so no other provider's
// start-failure behavior changes.
export function resolveStreamingStartFallback({ providerName, cloudTranscriptionMode, result }) {
  if (providerName !== "orukeet" || cloudTranscriptionMode !== "openwhispr") return null;
  if (result.code === "FEATURE_NOT_ENABLED") return "feature_disabled";
  if (result.code === "RATE_LIMITED") return "rate_limited";
  if (Number.isInteger(result.status) && result.status >= 500) return "session_unavailable";
  return null;
}
