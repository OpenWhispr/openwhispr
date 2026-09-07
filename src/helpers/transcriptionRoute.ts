// Single source of truth for batch speech-to-text routing across dictation,
// retry, and upload. Callers resolve their scope's settings into the flat base
// names and handle the OpenWhispr-cloud pipeline upstream; streaming provider
// selection is a live-recorder concern and stays in audioManager.
//
// Loaded by the renderer and the main process alike (main uses dynamic import):
// erasable TypeScript syntax only, explicit import extensions, no store imports.
// Routes never carry secrets — `auth.keyRef` names the key slot the executor
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
import type { ManagedEnterpriseRequestContext } from "../types/enterpriseIdentity.ts";

const BYOK_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

// Gemini's Interactions API takes inline base64 audio inside a 20 MB total
// request cap; base64 inflates 4/3, so cap the raw audio lower.
const GEMINI_FILE_SIZE_LIMIT = 14 * 1024 * 1024;

export function byokFileSizeLimit(provider: string): number {
  return provider === "gemini" ? GEMINI_FILE_SIZE_LIMIT : BYOK_FILE_SIZE_LIMIT;
}

const CUSTOM_ENDPOINT_INVALID_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.customEndpointInvalid";
const MANAGED_TRANSCRIPTION_UNAVAILABLE_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.managedTranscriptionUnavailable";

const STREAMING_ONLY_PROVIDER_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.streamingOnlyProvider";

const PROVIDER_KEY_MISSING_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.providerKeyMissing";

// Deepgram and AssemblyAI have no OpenAI-compatible /audio/transcriptions, so
// they exist only as realtime providers. A batch/upload/retry request for them
// has to fail closed: the fall-through at the end of resolveTranscriptionRoute
// would otherwise POST the user's audio to api.openai.com with their OpenAI key.
// Hand-maintained rather than derived from the registry: Corti's only model is
// realtime too, yet it batches through the proxy. Every other "realtime-only"
// decision (dictationStreamingRouting, audioManager.shouldUseStreaming, the
// upload picker and selector) derives from this set.
export const STREAMING_ONLY_PROVIDERS = new Set(["deepgram", "assemblyai"]);

export interface TranscriptionRouteSettings {
  transcriptionMode?: string;
  useLocalWhisper?: boolean;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
  cloudTranscriptionProvider?: string;
  cloudTranscriptionModel?: string;
  cloudTranscriptionBaseUrl?: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
  preferredLanguage?: string;
}

/**
 * Outcome of managed enterprise STT resolution, computed by the caller
 * (renderer: enterpriseIdentityStore; main: enterpriseIdentityManager). The
 * context is identity metadata for main-process re-validation, never a secret.
 */
export type ManagedTranscriptionResolution =
  | {
      kind: "managed";
      provider: "azure";
      deployment: string;
      context: ManagedEnterpriseRequestContext;
    }
  | { kind: "error"; message: string; code: string; messageKey?: string };

export interface TranscriptionRouteInput {
  /** Policy-EFFECTIVE, scope-resolved snapshot — the resolver never re-maps selections. */
  settings: TranscriptionRouteSettings;
  /** Optional fail-closed floor; renderer callers pass the policy store state, main-process callers omit it. */
  policy?: PolicyDecisionSnapshot | null;
  /** Provider registry, for the Tinfoil-host guard. Renderer passes ModelRegistry, main the raw JSON. */
  providers?: readonly TranscriptionProviderBaseUrl[];
  /** Managed enterprise STT outcome; when present it outranks every personal setting. */
  managed?: ManagedTranscriptionResolution | null;
  /**
   * Whether the selected provider's BYOK key is present — a presence flag, never
   * the key. Consulted only for realtime-only providers: the recorder skips
   * streaming when their key is missing, and the batch guard below would then
   * blame the transport instead of the key. Omit when unknown (retry, upload).
   */
  hasProviderKey?: boolean;
  request?: {
    /** Explicit model override; doubles as the Azure deployment name. */
    model?: string;
    /** Translation-aware language (dictation's getEffectiveSttLanguage) — wins over preferredLanguage. */
    effectiveLanguage?: string;
  };
}

export type TranscriptionRoute =
  | { transport: "error"; message: string; code?: string; messageKey?: string }
  | { transport: "local" }
  | {
      transport: "proxied";
      provider: "tinfoil" | "mistral" | "xai" | "corti" | "gemini";
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
      model: string | null;
      auth: { scheme: "bearer" | "azure-api-key" | "none"; keyRef: string | null };
      sizeCapBytes: number | null;
      language?: string;
    }
  | {
      // Workspace-managed Azure STT. Executed only in the main process, which
      // re-validates the context and holds the Entra token.
      transport: "managed";
      provider: "azure";
      deployment: string;
      context: ManagedEnterpriseRequestContext;
      sizeCapBytes: number;
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

// Prefix-matched rather than registry-checked on purpose: this module loads in
// the packaged main process without the registry, and strict validation would
// reset the model of anyone still on a retired id. The registry-backed picker
// rules live in settingsStore; transcriptionRouteModelAgreement.test.js pins the
// two together for every shipping model.
export function resolveByokModel(provider: string, configuredModel?: string): string {
  const trimmed = (configuredModel || "").trim();
  if (provider === "custom") return trimmed || "whisper-1";
  if (trimmed) {
    const matchesProvider =
      (provider === "groq" && trimmed.startsWith("whisper-large-v3")) ||
      (provider === "openai" && (trimmed.startsWith("gpt-4o") || trimmed === "whisper-1")) ||
      (provider === "mistral" && trimmed.startsWith("voxtral-")) ||
      (provider === "corti" && trimmed.startsWith("corti-")) ||
      (provider === "gemini" && trimmed.startsWith("gemini-")) ||
      (provider === "deepgram" && (trimmed.startsWith("nova-") || trimmed.startsWith("flux-"))) ||
      (provider === "assemblyai" &&
        (trimmed.startsWith("universal-") || trimmed.startsWith("slam-")));
    if (matchesProvider) return trimmed;
  }
  if (provider === "groq") return "whisper-large-v3-turbo";
  if (provider === "xai") return "grok-stt";
  if (provider === "mistral") return "voxtral-mini-latest";
  if (provider === "corti") return "corti-transcribe";
  if (provider === "gemini") return "gemini-3.5-transcribe";
  if (provider === "deepgram") return "nova-3";
  if (provider === "assemblyai") return "universal-3-5-pro";
  return "gpt-4o-mini-transcribe";
}

function error(message: string, code?: string, messageKey?: string): TranscriptionRoute {
  return { transport: "error", message, code, messageKey };
}

// Azure routes by deployment in the path and needs an api-version query, so the
// plain {base}/audio/transcriptions shape returns DeploymentNotFound. Takes the
// raw URL because normalization strips the suffix that marks a pinned deployment.
// Shared by self-hosted and Custom — deriveTranscriptionMode files Azure
// endpoints under either, depending on when the user configured them.
function buildBatchEndpoint(rawUrl: string, base: string, model: string | null): string {
  const fallback = buildApiUrl(base, "/audio/transcriptions");
  if (!isAzureOpenAIEndpoint(base)) return fallback;
  return buildAzureTranscriptionUrl(rawUrl, model || "") || fallback;
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
  managed: managedResolution,
  hasProviderKey,
  request,
}: TranscriptionRouteInput): TranscriptionRoute {
  const s = settings || {};
  const managed = policy?.status === "managed";
  const language =
    request?.effectiveLanguage ??
    (!s.preferredLanguage || s.preferredLanguage === "auto"
      ? undefined
      : s.preferredLanguage.split("-")[0]);

  // Managed enterprise STT outranks every personal setting; the resolution is
  // already policy-checked where it was computed (enterpriseIdentityStore /
  // enterpriseIdentityManager), so the selection floor below does not apply.
  if (managedResolution) {
    if (managedResolution.kind === "error") {
      return error(managedResolution.message, managedResolution.code, managedResolution.messageKey);
    }
    return {
      transport: "managed",
      provider: managedResolution.provider,
      deployment: managedResolution.deployment,
      context: managedResolution.context,
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      language,
    };
  }

  // A policy-effective "enterprise" selection with no managed resolution means
  // the managed config has not resolved (loading, evicted, or absent). Never
  // fall through to a personal lane in that state.
  if (s.transcriptionMode === "enterprise") {
    return error(
      "Managed transcription is not available right now. Try again in a moment.",
      "MANAGED_CONFIG_UNAVAILABLE",
      MANAGED_TRANSCRIPTION_UNAVAILABLE_MESSAGE_KEY
    );
  }

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

  // Self-hosted wins over everything, including stale useLocalWhisper flags.
  // The route needs a configured URL: `byok + custom` also persists
  // transcriptionMode="self-hosted" (deriveTranscriptionMode), so
  // mode-without-URL falls through to the custom branch (fail-closed there)
  // instead of breaking that population, and everything else fails closed.
  if (s.transcriptionMode === "self-hosted") {
    if (isSelfHostedTranscription(s)) {
      const rawUrl = (s.remoteTranscriptionUrl || "").trim();
      const base = normalizeBaseUrl(rawUrl);
      if (!base || !isSecureHttpEndpoint(base)) {
        return error("Self-hosted transcription URL is invalid or unsupported");
      }
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      return {
        transport: "http-batch",
        provider: "self-hosted",
        endpoint: buildBatchEndpoint(rawUrl, base, selfHostedModel),
        model: selfHostedModel,
        auth: { scheme: "none", keyRef: null },
        sizeCapBytes: null,
        language,
      };
    }
    if (s.cloudTranscriptionProvider !== "custom") {
      return error("Self-hosted transcription URL is not configured");
    }
  }

  // Engine and model selection stay with the local managers.
  if (s.useLocalWhisper) {
    return { transport: "local" };
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
  if (provider === "gemini") {
    return {
      transport: "proxied",
      provider,
      model,
      language,
      sizeCapBytes: GEMINI_FILE_SIZE_LIMIT,
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
    // Azure authenticates with the `api-key` header; Bearer is reserved for Entra ID.
    return {
      transport: "http-batch",
      provider: "custom",
      endpoint: buildBatchEndpoint(rawUrl, base, model),
      model,
      auth: {
        scheme: isAzureOpenAIEndpoint(base) ? "azure-api-key" : "bearer",
        keyRef: "custom",
      },
      sizeCapBytes: BYOK_FILE_SIZE_LIMIT,
      language,
    };
  }

  if (STREAMING_ONLY_PROVIDERS.has(provider)) {
    if (hasProviderKey === false) {
      return error(
        `No ${provider} API key configured. Add your key in Settings.`,
        "API_KEY_MISSING",
        PROVIDER_KEY_MISSING_MESSAGE_KEY
      );
    }
    return error(
      "This provider only supports live transcription. Choose another provider for file uploads and retries.",
      "STREAMING_ONLY_PROVIDER",
      STREAMING_ONLY_PROVIDER_MESSAGE_KEY
    );
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
