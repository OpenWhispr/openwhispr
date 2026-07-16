import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import {
  isSecureEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils.ts";
import { resolveSelfHostedTranscriptionModel } from "./selfHostedTranscription.js";

export const BYOK_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

// xAI STT supports 25 languages; language must be in this set to enable ITN via format=true
const XAI_STT_LANGUAGES = new Set([
  "ar",
  "cs",
  "da",
  "de",
  "en",
  "es",
  "fa",
  "fil",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "mk",
  "ms",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi",
]);

function validateBaseUrl(rawUrl) {
  const normalized = normalizeBaseUrl((rawUrl || "").trim());
  if (!normalized) return null;
  let protocol;
  try {
    protocol = new URL(normalized).protocol;
  } catch {
    return null;
  }
  if (protocol !== "http:" && protocol !== "https:") return null;
  if (!isSecureEndpoint(normalized)) return null;
  return normalized;
}

// Preserve an explicitly chosen model when it matches the provider (settings can
// hold a stale model after a provider switch or migration), else the provider default.
function resolveByokModel(provider, configuredModel) {
  const trimmed = (configuredModel || "").trim();
  if (trimmed) {
    const matchesProvider =
      (provider === "groq" && trimmed.startsWith("whisper-large-v3")) ||
      (provider === "openai" && (trimmed.startsWith("gpt-4o") || trimmed === "whisper-1")) ||
      (provider === "mistral" && trimmed.startsWith("voxtral-")) ||
      (provider === "corti" && trimmed.startsWith("corti-"));
    if (matchesProvider) return trimmed;
  }
  if (provider === "groq") return "whisper-large-v3-turbo";
  if (provider === "mistral") return "voxtral-mini-latest";
  if (provider === "corti") return "corti-transcribe";
  return "gpt-4o-mini-transcribe";
}

function error(messageKey, message) {
  return { transport: "error", messageKey, message };
}

// Single source of truth for batch speech-to-text routing across dictation,
// retry, and upload. Streaming provider selection is a live-recorder concern
// and stays in audioManager. Returns a route that never carries secrets —
// `auth.keyRef` names the secure-key slot for the executor to resolve.
export function resolveTranscriptionRoute(settings) {
  const s = settings || {};
  // Base language code, mirroring languageSupport.getBaseLanguageCode (not
  // imported: its languageRegistry.json import chain is renderer-only).
  const language =
    !s.preferredLanguage || s.preferredLanguage === "auto"
      ? undefined
      : s.preferredLanguage.split("-")[0];

  // Self-hosted wins over everything, including stale useLocalWhisper flags,
  // and fails closed on a missing or invalid URL.
  if (s.transcriptionMode === "self-hosted") {
    const rawUrl = (s.remoteTranscriptionUrl || "").trim();
    if (!rawUrl) {
      return error(
        "transcription.routeErrors.selfHostedUrlMissing",
        "Self-hosted transcription URL is not configured"
      );
    }
    const base = validateBaseUrl(rawUrl);
    if (!base) {
      return error(
        "transcription.routeErrors.selfHostedUrlInvalid",
        "Self-hosted transcription URL is invalid or unsupported"
      );
    }
    return {
      transport: "http-batch",
      provider: "self-hosted",
      endpoint: buildApiUrl(base, "/audio/transcriptions"),
      model: resolveSelfHostedTranscriptionModel(s),
      auth: { scheme: "none", keyRef: null },
      isSelfHosted: true,
      sizeCapBytes: null,
      language,
    };
  }

  if (s.useLocalWhisper) {
    const isNvidia = s.localTranscriptionProvider === "nvidia";
    return {
      transport: "local",
      provider: isNvidia ? "nvidia" : "whisper",
      model: isNvidia ? s.parakeetModel || "parakeet-tdt-0.6b-v3" : s.whisperModel || "base",
      language,
    };
  }

  if (s.cloudTranscriptionMode === "openwhispr") {
    return { transport: "openwhispr-cloud", requiresAuth: true, language };
  }

  const provider = s.cloudTranscriptionProvider || "openai";

  if (provider === "tinfoil") {
    // Attested enclave transport; the tinfoil client resolves its own model.
    return { transport: "ipc-proxy-batch", provider: "tinfoil", model: null, language };
  }
  if (provider === "mistral") {
    return {
      transport: "ipc-proxy-batch",
      provider: "mistral",
      model: resolveByokModel("mistral", s.cloudTranscriptionModel),
      language,
    };
  }
  if (provider === "xai") {
    return {
      transport: "ipc-proxy-batch",
      provider: "xai",
      model: null,
      // xAI rejects a model field and only accepts allowlisted languages (ITN via format=true)
      language: language && XAI_STT_LANGUAGES.has(language) ? language : undefined,
    };
  }
  if (provider === "corti") {
    return {
      transport: "ipc-proxy-batch",
      provider: "corti",
      model: resolveByokModel("corti", s.cloudTranscriptionModel),
      // Corti requires a concrete primaryLanguage; default to English when auto-detecting
      language: language || "en",
      cortiEnvironment: s.cortiEnvironment || "us",
      cortiTenant: (s.cortiTenant || "").trim() || "base",
    };
  }

  if (provider === "custom") {
    const rawUrl = (s.cloudTranscriptionBaseUrl || "").trim();
    if (!rawUrl) {
      return error(
        "transcription.routeErrors.customUrlMissing",
        "Custom transcription endpoint URL is not configured"
      );
    }
    const base = validateBaseUrl(rawUrl);
    if (!base) {
      return error(
        "transcription.routeErrors.customUrlInvalid",
        "Custom transcription endpoint URL is invalid or unsupported"
      );
    }
    const model = (s.cloudTranscriptionModel || "").trim() || "whisper-1";
    if (isAzureOpenAIEndpoint(base)) {
      const azureEndpoint = buildAzureTranscriptionUrl(base, model);
      if (!azureEndpoint) {
        return error(
          "transcription.routeErrors.customUrlInvalid",
          "Azure OpenAI endpoint requires a deployment name (set it as the model)"
        );
      }
      return {
        transport: "http-batch",
        provider: "custom",
        endpoint: azureEndpoint,
        model,
        auth: { scheme: "azure-api-key", keyRef: "custom" },
        isSelfHosted: false,
        sizeCapBytes: null,
        language,
      };
    }
    return {
      transport: "http-batch",
      provider: "custom",
      endpoint: buildApiUrl(base, "/audio/transcriptions"),
      model,
      auth: { scheme: "bearer", keyRef: "custom" },
      isSelfHosted: false,
      sizeCapBytes: null,
      language,
    };
  }

  const knownBase =
    provider === "groq" ? API_ENDPOINTS.GROQ_BASE : API_ENDPOINTS.TRANSCRIPTION_BASE;
  return {
    transport: "http-batch",
    provider: provider === "groq" ? "groq" : "openai",
    endpoint: buildApiUrl(knownBase, "/audio/transcriptions"),
    model: resolveByokModel(provider === "groq" ? "groq" : "openai", s.cloudTranscriptionModel),
    auth: { scheme: "bearer", keyRef: provider === "groq" ? "groq" : "openai" },
    isSelfHosted: false,
    sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
    language,
  };
}
