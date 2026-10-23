import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import {
  isSecureHttpEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils.ts";

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

// Custom (OpenAI-compatible) endpoints have no realtime websocket, so Note
// Recording runs them on the local chunk pipeline and POSTs each chunk to
// `<base>/audio/transcriptions` — the same validation and Azure handling as the
// dictation route in transcriptionRoute.ts, kept in sync by hand because that
// module is per-scope batch routing and this one is the meeting start contract.
export const MEETING_CUSTOM_PROVIDER_ID = "custom";

function resolveCustomBatchOptions({ rawUrl, model, language }) {
  const trimmedUrl = (rawUrl || "").trim();
  const base = normalizeBaseUrl(trimmedUrl);
  if (
    !trimmedUrl ||
    // The untouched store default — Custom was selected but never configured;
    // passing it through would route the custom key + audio to OpenAI.
    trimmedUrl === API_ENDPOINTS.TRANSCRIPTION_BASE ||
    !base ||
    !isSecureHttpEndpoint(base)
  ) {
    throw new Error("customEndpointNotConfigured");
  }
  const resolvedModel = (model || "").trim() || null;
  const fallback = buildApiUrl(base, "/audio/transcriptions");
  const isAzure = isAzureOpenAIEndpoint(base);
  return {
    provider: MEETING_CUSTOM_PROVIDER_ID,
    endpoint: isAzure
      ? buildAzureTranscriptionUrl(trimmedUrl, resolvedModel || "") || fallback
      : fallback,
    model: resolvedModel,
    // Azure authenticates with the `api-key` header; Bearer is reserved for Entra ID.
    authScheme: isAzure ? "azure-api-key" : "bearer",
    mode: "byok",
    language,
  };
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
  customBaseUrl,
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

  if (selectedProvider === MEETING_CUSTOM_PROVIDER_ID) {
    return resolveCustomBatchOptions({ rawUrl: customBaseUrl, model: selectedModel, language });
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
