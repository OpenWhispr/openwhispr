import { isSelfHostedTranscription } from "./selfHostedTranscription.js";

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
  selectedProvider,
  selectedModel,
  remoteTranscriptionUrl,
  remoteTranscriptionModel,
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

  // Self-hosted servers speak batch HTTP, not the realtime socket protocol, so
  // Note Recording chunks through the same /audio/transcriptions endpoint that
  // dictation, retry, and upload use. The main process resolves and validates
  // the endpoint via resolveTranscriptionRoute and fails closed without one, so
  // this can never fall through to a realtime provider the user did not select.
  if (transcriptionMode === "self-hosted") {
    if (!isSelfHostedTranscription({ transcriptionMode, remoteTranscriptionUrl })) {
      throw new Error(
        "Self-hosted Note Recording needs a transcription server URL. Add one in Settings."
      );
    }
    return {
      provider: "self-hosted",
      url: remoteTranscriptionUrl.trim(),
      model: (remoteTranscriptionModel || "").trim() || null,
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
