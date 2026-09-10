const DEFAULT_MANAGED_PROVIDER = {
  id: "openai",
  models: [{ id: "gpt-4o-mini-transcribe", default: true }],
};

// Mirrors the suffix stripping in config/constants.ts normalizeBaseUrl for the
// batch transcription route. Replicated rather than imported: this module is a
// plain .js seam loaded by the renderer and the main process alike, and
// constants.ts pulls in the wider renderer config graph.
const TRANSCRIPTION_BASE_SUFFIXES = [
  [/\/v1\/audio\/transcriptions$/i, "/v1"],
  [/\/audio\/transcriptions$/i, ""],
];

const buildSelfHostedTranscriptionEndpoint = (rawUrl) => {
  let base = rawUrl.trim();
  for (const [pattern, replacement] of TRANSCRIPTION_BASE_SUFFIXES) {
    if (pattern.test(base)) {
      base = base.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }
  return `${base.replace(/\/+$/, "")}/audio/transcriptions`;
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
  remoteTranscriptionUrl,
  remoteTranscriptionModel,
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

  if (transcriptionMode === "self-hosted") {
    const rawUrl = (remoteTranscriptionUrl || "").trim();
    if (!rawUrl) {
      throw new Error("Self-hosted transcription URL is not configured");
    }
    const model = (remoteTranscriptionModel || "").trim();
    return {
      provider: "self-hosted",
      endpoint: buildSelfHostedTranscriptionEndpoint(rawUrl),
      model: model || null,
      language,
    };
  }

  if (transcriptionMode !== "providers") {
    throw new Error(`Unsupported Note Recording transcription mode: ${transcriptionMode}`);
  }

  const provider = byokProviders.find((candidate) => candidate.id === selectedProvider);
  if (!provider) {
    throw new Error(`Unsupported Note Recording provider: ${selectedProvider || "none selected"}`);
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
