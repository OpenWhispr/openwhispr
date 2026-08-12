// Single source of truth for batch speech-to-text routing across dictation,
// retry, and upload. Callers resolve their scope's settings into the flat
// base names and handle the OpenWhispr-cloud pipeline upstream; streaming
// provider selection is a live-recorder concern and stays in audioManager.
//
// Loaded by BOTH the renderer and the main process (dynamic import, same
// precedent as the deleted retryTranscriptionRouting.js) — erasable
// TypeScript syntax only, explicit import extensions, no store imports.
// Routes never carry secrets: `auth.keyRef` names the key slot the executor
// resolves itself.
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import {
  isSecureHttpEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils.ts";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription.js";
import {
  isTranscriptionSelectionAllowed,
  type PolicyDecisionSnapshot,
} from "../stores/policyRules.ts";
import {
  isTinfoilInferenceUrl,
  TINFOIL_PROXY_REQUIRED_ERROR,
  type TranscriptionProviderBaseUrl,
} from "../services/transcriptionBaseUrl.ts";

export const BYOK_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

export const CUSTOM_ENDPOINT_INVALID_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.customEndpointInvalid";

export type TranscriptionRouteContext = "dictation" | "meeting" | "upload";

export interface TranscriptionRouteSettings {
  transcriptionMode?: string;
  useLocalWhisper?: boolean;
  localTranscriptionProvider?: string;
  whisperModel?: string;
  parakeetModel?: string;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
  cloudTranscriptionProvider?: string;
  cloudTranscriptionModel?: string;
  cloudTranscriptionBaseUrl?: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  preferredLanguage?: string;
}

export interface TranscriptionRouteInput {
  context: TranscriptionRouteContext;
  /** Policy-EFFECTIVE, scope-resolved snapshot — the resolver never re-maps selections. */
  settings: TranscriptionRouteSettings;
  /** Optional fail-closed floor; renderer callers pass the policy store state, main-process callers omit it. */
  policy?: PolicyDecisionSnapshot | null;
  /** Transcription provider registry; main-process callers pass [] (renderer pre-flight owns URL-vs-provider guards there). */
  providers?: readonly TranscriptionProviderBaseUrl[];
  request?: {
    /** Explicit model override; doubles as the Azure deployment name. */
    model?: string;
    /** Translation-aware language (dictation's getEffectiveSttLanguage) — wins over preferredLanguage. */
    effectiveLanguage?: string;
  };
}

export type TranscriptionRoute =
  | { transport: "error"; message: string; code?: string; messageKey?: string }
  | { transport: "local"; provider: "whisper" | "nvidia"; model: string; language?: string }
  | {
      transport: "proxied";
      provider: "tinfoil" | "mistral" | "xai" | "corti";
      model: string | null;
      language?: string;
      sizeCapBytes: number;
      cortiEnvironment?: string;
      cortiTenant?: string;
    }
  | {
      transport: "http-batch";
      provider: "self-hosted" | "custom" | "openai" | "groq";
      endpoint: string;
      model: string;
      auth: { scheme: "bearer" | "azure-api-key" | "none"; keyRef: string | null };
      sizeCapBytes: number | null;
      language?: string;
    };

// xAI STT supports 25 languages; language must be in this set to enable ITN via format=true
export const XAI_STT_LANGUAGES = new Set([
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

// Preserve an explicitly chosen model when it matches the provider (settings can
// hold a stale model after a provider switch or migration), else the provider
// default. Mirrors audioManager.getTranscriptionModel so retry and upload stop
// drifting from dictation.
export function resolveByokModel(provider: string, configuredModel?: string): string {
  const trimmed = (configuredModel || "").trim();
  if (provider === "custom") return trimmed || "whisper-1";
  if (trimmed) {
    const matchesProvider =
      (provider === "groq" && trimmed.startsWith("whisper-large-v3")) ||
      (provider === "openai" && (trimmed.startsWith("gpt-4o") || trimmed === "whisper-1")) ||
      (provider === "mistral" && trimmed.startsWith("voxtral-")) ||
      (provider === "corti" && trimmed.startsWith("corti-"));
    if (matchesProvider) return trimmed;
  }
  if (provider === "groq") return "whisper-large-v3-turbo";
  if (provider === "xai") return "grok-stt";
  if (provider === "mistral") return "voxtral-mini-latest";
  if (provider === "corti") return "corti-transcribe";
  return "gpt-4o-mini-transcribe";
}

function error(message: string, code?: string, messageKey?: string): TranscriptionRoute {
  return { transport: "error", message, code, messageKey };
}

function customEndpointError(managed: boolean): TranscriptionRoute {
  if (managed) {
    return error(
      "Transcription is restricted by your organization.",
      "POLICY_RESTRICTED",
      "common.policyTranscriptionRestricted"
    );
  }
  return error(
    "Custom transcription endpoint is invalid or unsupported",
    "CUSTOM_ENDPOINT_INVALID",
    CUSTOM_ENDPOINT_INVALID_MESSAGE_KEY
  );
}

export function resolveTranscriptionRoute({
  settings,
  policy,
  providers = [],
  request,
}: TranscriptionRouteInput): TranscriptionRoute {
  const s = settings || {};
  const managed = policy?.status === "managed";

  // Fail-closed floor only: callers pass policy-effective settings, so a
  // disallowed selection here means the policy layer was bypassed upstream.
  if (
    managed &&
    !isTranscriptionSelectionAllowed(policy!, {
      mode: (s.transcriptionMode || (s.useLocalWhisper ? "local" : "providers")) as never,
      provider: s.cloudTranscriptionProvider || "",
    })
  ) {
    return error(
      "Transcription is restricted by your organization.",
      "POLICY_RESTRICTED",
      "common.policyTranscriptionRestricted"
    );
  }

  const language =
    request?.effectiveLanguage ??
    (!s.preferredLanguage || s.preferredLanguage === "auto"
      ? undefined
      : s.preferredLanguage.split("-")[0]);

  // Self-hosted wins over everything, including stale useLocalWhisper flags.
  // The route needs a configured URL: `byok + custom` also persists
  // transcriptionMode="self-hosted" (deriveTranscriptionMode), so
  // mode-without-URL falls through to the custom branch (fail-closed there)
  // instead of breaking that population, and everything else fails closed.
  if (s.transcriptionMode === "self-hosted") {
    if (isSelfHostedTranscription(s)) {
      const base = normalizeBaseUrl((s.remoteTranscriptionUrl || "").trim());
      if (!base || !isSecureHttpEndpoint(base)) {
        return error("Self-hosted transcription URL is invalid or unsupported");
      }
      return {
        transport: "http-batch",
        provider: "self-hosted",
        endpoint: buildApiUrl(base, "/audio/transcriptions"),
        model: resolveSelfHostedTranscriptionModel(s),
        auth: { scheme: "none", keyRef: null },
        sizeCapBytes: null,
        language,
      };
    }
    if (s.cloudTranscriptionProvider !== "custom") {
      return error("Self-hosted transcription URL is not configured");
    }
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

  const provider = s.cloudTranscriptionProvider || "openai";
  const model = resolveByokModel(provider, request?.model ?? s.cloudTranscriptionModel);

  if (provider === "tinfoil" || provider === "mistral" || provider === "xai") {
    return {
      transport: "proxied",
      provider,
      // Tinfoil's attested client resolves its own model; xAI's API takes none.
      model: provider === "mistral" ? model : provider === "xai" ? "grok-stt" : null,
      language:
        provider === "xai" && language && !XAI_STT_LANGUAGES.has(language) ? undefined : language,
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
    };
  }
  if (provider === "corti") {
    return {
      transport: "proxied",
      provider,
      model,
      // Corti requires a concrete primaryLanguage; default to English when auto-detecting
      language: language || "en",
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      cortiEnvironment: s.cortiEnvironment || "us",
      cortiTenant: (s.cortiTenant || "").trim() || "base",
    };
  }

  if (provider === "custom") {
    const rawUrl = (s.cloudTranscriptionBaseUrl || "").trim();
    const base = normalizeBaseUrl(rawUrl);
    if (
      !rawUrl ||
      // The untouched store default — Custom was selected but never configured;
      // passing it through would route the custom key + audio to OpenAI.
      rawUrl === API_ENDPOINTS.TRANSCRIPTION_BASE ||
      !base ||
      !isSecureHttpEndpoint(base)
    ) {
      return customEndpointError(managed);
    }
    if (isTinfoilInferenceUrl(base, providers)) {
      return error(TINFOIL_PROXY_REQUIRED_ERROR);
    }
    if (isAzureOpenAIEndpoint(base)) {
      // Built from the raw base — normalization strips the /audio/transcriptions
      // suffix that marks a deployment the user pinned. Missing deployment falls
      // back to the plain path (Azure then reports DeploymentNotFound itself).
      const azureUrl = buildAzureTranscriptionUrl(rawUrl, model);
      return {
        transport: "http-batch",
        provider: "custom",
        endpoint: azureUrl || buildApiUrl(base, "/audio/transcriptions"),
        model,
        auth: { scheme: "azure-api-key", keyRef: "custom" },
        sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
        language,
      };
    }
    return {
      transport: "http-batch",
      provider: "custom",
      endpoint: buildApiUrl(base, "/audio/transcriptions"),
      model,
      auth: { scheme: "bearer", keyRef: "custom" },
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      language,
    };
  }

  const isGroq = provider === "groq";
  return {
    transport: "http-batch",
    provider: isGroq ? "groq" : "openai",
    endpoint: buildApiUrl(
      isGroq ? API_ENDPOINTS.GROQ_BASE : API_ENDPOINTS.TRANSCRIPTION_BASE,
      "/audio/transcriptions"
    ),
    model,
    auth: { scheme: "bearer", keyRef: isGroq ? "groq" : "openai" },
    sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
    language,
  };
}
