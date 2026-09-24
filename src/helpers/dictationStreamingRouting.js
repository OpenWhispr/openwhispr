// Single source of truth for dictation/notes realtime STT routing: which
// streaming provider a settings state resolves to, and the exact session
// options every provider receives over IPC. Provider facts scattered across
// call sites is what broke default dictation in 1.8.2 (#1624: the
// openai-realtime entry never sent `provider`, and the hardened main-process
// allowlist rejected undefined). Pure module, mirrors meetingTranscriptionRouting.
import { isOrukeetStreaming } from "./selfHostedTranscription.js";
import { STREAMING_ONLY_PROVIDERS } from "./transcriptionRoute.ts";
import modelRegistryData from "../models/modelRegistryData.json" with { type: "json" };

export const ORUKEET_MODEL = "orukeet-v0.1.0";
const ORUKEET_LANGUAGES = new Set(
  modelRegistryData.parakeetModels[ORUKEET_MODEL].supportedLanguages
);

export const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

// REALTIME_MODELS is the OpenAI-only shortcut (it forces "openai-realtime"), so
// Gemini's live model routes on its own. Keying on the model id and not the
// provider is required: the batch model on the same provider is HTTP-only.
export const GEMINI_LIVE_MODEL = "gemini-3.5-transcribe-live";

export function defaultStreamingProviderName(context) {
  return context === "notes" ? "deepgram" : "openai-realtime";
}

// The managed Orukeet route carries no language on the wire and the model
// covers a fixed list, so an explicitly selected language outside it stays on
// the batch path, the one route that honors the user's language end to end.
// "auto" (the default) uses the model's own detection, as every other
// streaming provider does.
export function resolveManagedOrukeetRoute({ settings, sttConfig, language }) {
  if (
    settings.cloudTranscriptionMode !== "openwhispr" ||
    sttConfig?.dictation?.mode !== "streaming" ||
    sttConfig?.streamingProvider !== "orukeet"
  ) {
    return null;
  }
  if (!language || language === "auto") return "orukeet";
  const base = language.split("-")[0].toLowerCase();
  return ORUKEET_LANGUAGES.has(base) ? "orukeet" : "language_unsupported";
}

export function resolveStreamingProviderName({ settings, context, sttConfig, language }) {
  // The managed rollout must outrank a stale personal model selection. Notes
  // keep their separate provider contract; this endpoint is for dictation.
  if (context === "dictation") {
    const managedOrukeet = resolveManagedOrukeetRoute({ settings, sttConfig, language });
    if (managedOrukeet === "orukeet") return "orukeet";
    if (managedOrukeet === "language_unsupported") return defaultStreamingProviderName(context);
  }
  if (isOrukeetStreaming(settings)) return "orukeet";
  if (settings.cloudTranscriptionProvider === "tinfoil") {
    return "tinfoil-realtime";
  }
  if (
    settings.cloudTranscriptionProvider === "corti" &&
    settings.cloudTranscriptionMode === "byok"
  ) {
    return "corti";
  }
  if (
    settings.cloudTranscriptionProvider === "gemini" &&
    settings.cloudTranscriptionModel === GEMINI_LIVE_MODEL
  ) {
    return "gemini";
  }
  // Realtime-only providers have no batch endpoint, so BYOK selection alone
  // routes them, and their renderer channel name is the bare provider id. Ahead
  // of the REALTIME_MODELS check so a stale OpenAI model id in settings can't
  // hijack the provider, matching the tinfoil/corti precedent above.
  if (
    settings.cloudTranscriptionMode === "byok" &&
    STREAMING_ONLY_PROVIDERS.has(settings.cloudTranscriptionProvider)
  ) {
    return settings.cloudTranscriptionProvider;
  }
  if (REALTIME_MODELS.has(settings.cloudTranscriptionModel)) {
    return "openai-realtime";
  }
  return sttConfig?.streamingProvider || defaultStreamingProviderName(context);
}

export function buildStreamingSessionOptions({
  providerName,
  settings,
  language,
  keyterms,
  voiceAgentRequested = false,
}) {
  const options = {
    provider: providerName,
    sampleRate: 16000,
    language: language && language !== "auto" ? language : undefined,
    keyterms,
    model: settings.cloudTranscriptionModel,
    mode: settings.cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
    environment: settings.cortiEnvironment,
    tenant: settings.cortiTenant,
  };
  // Tinfoil realtime shows the live preview for normal dictation (#1120), but
  // assistant voice skips it because the Assistant panel owns that surface.
  if (providerName === "tinfoil-realtime" && !voiceAgentRequested) {
    options.preview = true;
  }
  if (providerName === "orukeet") {
    options.model = ORUKEET_MODEL;
    if (options.mode === "byok") {
      options.baseUrl = settings.remoteTranscriptionUrl || settings.cloudTranscriptionBaseUrl;
    }
  }
  return options;
}
