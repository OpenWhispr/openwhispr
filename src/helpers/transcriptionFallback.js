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

// Denials the user has to act on, which batch could not absorb either. An
// account switch mid-start is one too: the recording must not continue under
// a different account.
const USER_ACTIONABLE_START_FAILURES = new Set([
  "AUTH_EXPIRED",
  "AUTH_REQUIRED",
  "AUTH_CONTEXT_CHANGED",
  "ACCOUNT_REQUIRED",
  "UPGRADE_REQUIRED",
  "LIMIT_REACHED",
]);

// Every other managed Orukeet start failure goes to batch rather than losing
// the dictation: the rollout was turned off for this account, its mint window
// is exhausted, or the session service, the network, the WebSocket or the
// session response failed. Scoped to the managed Orukeet route so no other
// provider's start-failure behavior changes.
export function resolveStreamingStartFallback({ providerName, cloudTranscriptionMode, result }) {
  if (providerName !== "orukeet" || cloudTranscriptionMode !== "openwhispr") return null;
  if (USER_ACTIONABLE_START_FAILURES.has(result.code) || result.code?.startsWith("POLICY_")) {
    return null;
  }
  if (result.code === "FEATURE_NOT_ENABLED") return "feature_disabled";
  if (result.code === "RATE_LIMITED") return "rate_limited";
  return "session_unavailable";
}
