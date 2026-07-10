// Map a reasoning cloud routing to the InferenceMode its Settings tab selects on.
// Mirrors deriveTranscriptionMode (byok custom → self-hosted, other cloud → providers).
export function deriveReasoningMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

// Fan a cleanup config out to all four LLM scopes; the three non-cleanup scopes
// mirror only cloud routing plus the derived mode (each tab selects on its mode).
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  // The three non-cleanup scopes mirror only the cloud routing fields that are set.
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
  };
}

// Onboarding "use Corti everywhere" payloads. `reasoning` is null outside the EU
// region or when the provider/model is missing; useCleanupModel is forced true so routing sticks.
export function buildCortiOnboardingPayloads(
  transcriptionProvider,
  reasoningProvider,
  environment
) {
  const transcription = {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: transcriptionProvider?.models?.[0]?.id,
  };
  const reasoningModel = environment === "eu" ? reasoningProvider?.models?.[0]?.id : undefined;
  const reasoning = reasoningModel
    ? {
        useCleanupModel: true,
        cleanupProvider: "corti",
        cleanupModel: reasoningModel,
        cleanupCloudMode: "byok",
      }
    : null;
  return { transcription, reasoning };
}
