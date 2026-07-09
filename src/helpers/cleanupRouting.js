// Map a cleanup cloud routing to the InferenceMode its Settings tab selects on.
// Mirrors deriveTranscriptionMode: BYOK cloud is "self-hosted" for the custom
// provider and "providers" for any other cloud provider; otherwise "openwhispr".
export function deriveCleanupMode(cloudMode, provider) {
  if (cloudMode === "byok") {
    return provider === "custom" ? "self-hosted" : "providers";
  }
  return "openwhispr";
}

// Fan a cleanup config out to dictationCleanup and noteFormatting so cleanup
// text never reaches a second LLM provider; noteFormatting mirrors only cloud routing.
export function buildCleanupScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  const noteFormatting = { mode };
  if (settings.cleanupProvider !== undefined) noteFormatting.provider = settings.cleanupProvider;
  if (settings.cleanupModel !== undefined) noteFormatting.model = settings.cleanupModel;
  if (settings.cleanupCloudMode !== undefined) noteFormatting.cloudMode = settings.cleanupCloudMode;
  return { dictationCleanup, noteFormatting };
}

// Build the onboarding "use Corti everywhere" payloads from the Corti registry
// entries. `cleanup` is null when the reasoning provider or its first model is
// missing, so the caller skips cleanup routing instead of writing an undefined
// model. `useCleanupModel` is forced true so the routing takes effect even if
// the user had cleanup toggled off.
export function buildCortiOnboardingPayloads(transcriptionProvider, reasoningProvider) {
  const transcription = {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: transcriptionProvider?.models?.[0]?.id,
  };
  const cleanupModel = reasoningProvider?.models?.[0]?.id;
  const cleanup = cleanupModel
    ? {
        useCleanupModel: true,
        cleanupProvider: "corti",
        cleanupModel,
        cleanupCloudMode: "byok",
      }
    : null;
  return { transcription, cleanup };
}
