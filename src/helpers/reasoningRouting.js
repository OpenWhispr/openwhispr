// Map a reasoning provider to the InferenceMode its Settings tab selects on.
// Mirrors deriveTranscriptionMode (custom → self-hosted, built-in → local).
export function deriveReasoningMode(provider) {
  if (provider === "custom") return "self-hosted";
  if (provider === "local") return "local";
  return "providers";
}

// Fan a cleanup config out to all four LLM scopes; the three non-cleanup scopes
// mirror only the provider routing plus the derived mode (each tab selects on
// its own mode).
export function buildReasoningScopePatches(settings, mode) {
  const dictationCleanup = { ...settings, cleanupMode: mode };
  // The three non-cleanup scopes mirror only the routing fields that are set.
  const routing = {
    ...(settings.cleanupProvider !== undefined ? { provider: settings.cleanupProvider } : {}),
    ...(settings.cleanupModel !== undefined ? { model: settings.cleanupModel } : {}),
  };
  return {
    dictationCleanup,
    noteFormatting: { mode, ...routing },
    dictationAgent: { mode, ...routing },
    chatIntelligence: { mode, ...routing },
  };
}

// Onboarding "use Corti everywhere" payloads. Transcription always routes to
// Corti. Reasoning routes to Corti only in the EU region with an API key, since
// Corti Models is EU-only and needs its own key; otherwise it routes to the
// built-in local model so clinical text never leaves the machine. The model id
// is left unset on that path — startup auto-adopts the bundled Gemma build for
// any local scope without one. useCleanupModel is forced true either way so the
// routing sticks.
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
        }
      : { useCleanupModel: true, cleanupProvider: "local" };
  return { transcription, reasoning };
}
