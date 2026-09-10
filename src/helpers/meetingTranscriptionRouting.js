const DEFAULT_MANAGED_PROVIDER = {
  id: "openai",
  models: [{ id: "gpt-4o-mini-transcribe", default: true }],
};

const resolveModel = (provider, selectedModel) =>
  provider.models.find((model) => model.id === selectedModel)?.id ??
  provider.models.find((model) => model.default)?.id ??
  provider.models[0]?.id;

export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
  selectedProvider,
  selectedModel,
  byokProviders,
  managedProviders,
  cortiEnvironment,
  cortiTenant,
  keyterms,
}) {
  if (transcriptionMode === "local") {
    return {
      provider: "local",
      localProvider,
      localModel:
        localProvider === "nvidia"
          ? parakeetModel || "parakeet-tdt-0.6b-v3"
          : localProvider === "cohere"
            ? cohereModel || "cohere-transcribe-03-2026"
            : whisperModel || "base",
      language,
    };
  }

  if (transcriptionMode === "openwhispr") {
    const provider = managedProviders?.[0] ?? DEFAULT_MANAGED_PROVIDER;
    return {
      provider: `${provider.id}-realtime`,
      model: resolveModel(provider, selectedModel),
      mode: "openwhispr",
      language,
    };
  }

  // These two are reachable from a settings copy the user never made by hand —
  // the 1.6.10 follow-flag migration carried a dictation choice Note Recording
  // cannot serve — so they are sentinels that MeetingRecordingMount translates,
  // not English sentences. Anything after the colon is an argument.
  if (transcriptionMode === "self-hosted") {
    throw new Error("unsupportedSelfHosted");
  }

  if (transcriptionMode !== "providers") {
    throw new Error(`Unsupported Note Recording transcription mode: ${transcriptionMode}`);
  }

  const provider = byokProviders.find((candidate) => candidate.id === selectedProvider);
  if (!provider) {
    throw new Error(
      selectedProvider ? `unsupportedProvider:${selectedProvider}` : "noProviderSelected"
    );
  }

  const options = {
    provider: `${provider.id}-realtime`,
    model: resolveModel(provider, selectedModel),
    mode: "byok",
    language,
  };

  if (provider.id === "corti") {
    return {
      ...options,
      environment: cortiEnvironment,
      tenant: cortiTenant,
      keyterms,
    };
  }

  return options;
}
