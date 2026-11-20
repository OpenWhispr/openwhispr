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

// A device policy's refusal is as final as a workspace's.
export function isTranscriptionPolicyRefusal(error) {
  return typeof error?.code === "string" && /^(DEVICE_)?POLICY_/.test(error.code);
}

// Orukeet over OpenWhispr Cloud sessions, as opposed to a self-hosted server.
export function isManagedOrukeetStream({ providerName, cloudTranscriptionMode }) {
  return providerName === "orukeet" && cloudTranscriptionMode === "openwhispr";
}

// Routes that open a session per recording. The pill, start cue and Escape act while
// it connects, and the audio spoken meanwhile is held for it.
export function holdsAudioUntilConnected({ providerName, cloudTranscriptionMode }) {
  return (
    providerName === "sarvam" || isManagedOrukeetStream({ providerName, cloudTranscriptionMode })
  );
}

// These routes can transcribe the whole recording over their own batch API
// when the streaming endpoint is unavailable. Policy and account refusals still apply.
export function resolveStreamingStartFallback({ providerName, cloudTranscriptionMode, result }) {
  if (USER_ACTIONABLE_START_FAILURES.has(result.code) || isTranscriptionPolicyRefusal(result)) {
    return null;
  }
  if (providerName === "sarvam" && cloudTranscriptionMode === "byok") {
    return result.code === "API_KEY_MISSING" ? null : "session_unavailable";
  }
  if (!isManagedOrukeetStream({ providerName, cloudTranscriptionMode })) return null;
  if (result.code === "FEATURE_NOT_ENABLED") return "feature_disabled";
  if (result.code === "RATE_LIMITED") return "rate_limited";
  return "session_unavailable";
}
