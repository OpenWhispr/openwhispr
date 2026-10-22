import { isSecureWebSocketEndpoint } from "../utils/urlUtils";

// Note recording only offers providers the main process will actually run:
// meeting prepare/start check ALLOWED_MEETING_PROVIDERS (derived from the
// streaming client table in meetingStreamingProviders.js) and reject anything
// else with no user-visible message. Without this intersection, every registry
// model marked `streaming: true` reaches the notes picker — including
// dictation-only ones like Gemini Live — and fails silently there. The closure
// is pinned by test/helpers/meetingStreamingProviders.test.js.
export const MEETING_STREAMING_PROVIDER_IDS = [
  "openai",
  "assemblyai",
  "deepgram",
  "corti",
  "tinfoil",
];

export function filterMeetingStreamingProviders(providers) {
  return providers.filter((provider) => MEETING_STREAMING_PROVIDER_IDS.includes(provider.id));
}

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
  realtimeUrl,
  realtimeModel,
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

  // Errors from here on are sentinels that MeetingRecordingMount translates, not
  // English sentences; anything after the colon is an argument. Several are
  // reachable from a settings copy the user never made by hand — the 1.6.10
  // follow-flag migration carried dictation choices into Note Recording.
  //
  // Self-hosted means a server speaking the OpenAI Realtime protocol at a
  // WebSocket URL the user typed for Note Recording. It never inherits the
  // dictation HTTP endpoint or a cloud provider selection, and there is no
  // HTTP fallback: a missing or unsafe URL fails here.
  if (transcriptionMode === "self-hosted") {
    const url = typeof realtimeUrl === "string" ? realtimeUrl.trim() : "";
    if (!url) throw new Error("selfHostedRealtimeUrlMissing");
    if (!isSecureWebSocketEndpoint(url)) throw new Error("selfHostedRealtimeUrlInvalid");
    // A blank model would fall through to the OpenAI default model id, which a
    // self-hosted server either refuses (Speaches needs ?model=) or ignores. A
    // model already in the URL's query counts.
    const model = typeof realtimeModel === "string" ? realtimeModel.trim() : "";
    if (!model && !new URL(url).searchParams.get("model")?.trim()) {
      throw new Error("selfHostedRealtimeModelMissing");
    }
    return {
      provider: "openai-compatible-realtime",
      url,
      model,
      mode: "self-hosted",
      language,
    };
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
