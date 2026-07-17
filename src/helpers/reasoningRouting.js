// Map a reasoning cloud routing to the InferenceMode its Settings tab selects on.
// Mirrors deriveTranscriptionMode (byok custom → self-hosted, other cloud → providers).
export function deriveReasoningMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

// Fan a cleanup config out to all five LLM scopes; the four non-cleanup scopes
// mirror only cloud routing plus the derived mode (each tab selects on its mode).
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  // The four non-cleanup scopes mirror only the cloud routing fields that are set.
  const routing = {
    ...(settings.cleanupProvider !== undefined ? { provider: settings.cleanupProvider } : {}),
    ...(settings.cleanupModel !== undefined ? { model: settings.cleanupModel } : {}),
    ...(settings.cleanupCloudMode !== undefined ? { cloudMode: settings.cleanupCloudMode } : {}),
  };
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
