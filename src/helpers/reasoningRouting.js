// Map a reasoning cloud routing to the InferenceMode its Settings tab selects on.
// Mirrors deriveTranscriptionMode (byok custom → self-hosted, other cloud → providers).
export function deriveReasoningMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(own, fallbackMode) {
  if (own.cloudBaseUrl || own.remoteUrl) return false;
  return !!fallbackMode && own.mode === fallbackMode;
}

const MIRRORED_ROUTING_FIELDS = [
  ["cleanupProvider", "provider"],
  ["cleanupModel", "model"],
  ["cleanupCloudMode", "cloudMode"],
  ["cleanupCloudBaseUrl", "cloudBaseUrl"],
  ["cleanupRemoteUrl", "remoteUrl"],
  ["cleanupCustomApiKey", "customApiKey"],
];

// Fan a cleanup config out to all five LLM scopes; the four non-cleanup scopes
// mirror the routing fields that are set plus the derived mode (each tab selects
// on its mode). The endpoint and key ride along so a self-hosted or custom
// endpoint is reachable from every scope, not just the one onboarding wrote.
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  const routing = Object.fromEntries(
    MIRRORED_ROUTING_FIELDS.filter(([cleanupKey]) => settings[cleanupKey] !== undefined).map(
      ([cleanupKey, field]) => [field, settings[cleanupKey]]
    )
  );
  return {
    dictationCleanup,
    noteFormatting: { mode, ...routing },
    dictationAgent: { mode, ...routing },
    chatIntelligence: { mode, ...routing },
    dictationTranslation: { mode, ...routing },
  };
}

// Onboarding "use Corti everywhere" payloads. Transcription always routes to
// Corti. Reasoning routes to Corti only in the EU region with an API key, since
// Corti Models is EU-only and needs its own key; otherwise it routes to the
// HIPAA-compliant OpenWhispr Cloud so clinical text never reaches a third party.
// useCleanupModel is forced true either way so the routing sticks.
export function buildCortiOnboardingPayloads(
  transcriptionProvider,
  reasoningProvider,
  environment,
  hasApiKey
) {
  const transcription = {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: transcriptionProvider?.models?.[0]?.id,
  };
  const cortiModel = reasoningProvider?.models?.[0]?.id;
  const reasoning =
    environment === "eu" && hasApiKey && cortiModel
      ? {
          useCleanupModel: true,
          cleanupProvider: "corti",
          cleanupModel: cortiModel,
          cleanupCloudMode: "byok",
        }
      : { useCleanupModel: true, cleanupCloudMode: "openwhispr" };
  return { transcription, reasoning };
}
