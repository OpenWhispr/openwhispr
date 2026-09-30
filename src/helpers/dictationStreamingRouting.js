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

// Existing default retained during the opt-in group-score rollout. Scores are
// not calibrated probabilities; see docs/orukeet-streaming-language.md for
// the expanded evaluation and the separate three/six-second behavior.
const ORUKEET_LANGUAGE_FALLBACK_MIN_CONFIDENCE = 0.9;
const ORUKEET_LANGUAGE_FALLBACK_MIN_AUDIO_SECONDS = 3;

export function isOrukeetLanguage(code) {
  if (typeof code !== "string" || !code) return false;
  return ORUKEET_LANGUAGES.has(code.split("-")[0].toLowerCase());
}

// Auto mode only: an explicit language outside the 25 never reaches Orukeet
// (resolveManagedOrukeetRoute), and an explicit supported one is the user's
// statement of what they speak. Only the final estimate counts; early
// `language` events are provisional.
export function shouldRetranscribeOrukeetLanguage({ language, final }) {
  if (language && language !== "auto") return false;
  if (!final || typeof final.language !== "string" || isOrukeetLanguage(final.language)) {
    return false;
  }
  return (
    Number.isFinite(final.languageConfidence) &&
    final.languageConfidence >= ORUKEET_LANGUAGE_FALLBACK_MIN_CONFIDENCE &&
    Number.isFinite(final.languageAudioSeconds) &&
    final.languageAudioSeconds >= ORUKEET_LANGUAGE_FALLBACK_MIN_AUDIO_SECONDS
  );
}

// Opt-in, server-controlled rollout. Missing/unknown modes retain the existing
// rule; shadow records the comparison without changing the user's result.
const ORUKEET_LANGUAGE_ROUTING_MODES = new Set(["shadow", "supported-0.30", "supported-0.10"]);
const validScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

export function evaluateOrukeetLanguageRouting({ language, final, mode }) {
  const legacyFallback = shouldRetranscribeOrukeetLanguage({ language, final });
  if (!ORUKEET_LANGUAGE_ROUTING_MODES.has(mode)) {
    return { fallback: legacyFallback, comparison: null };
  }
  const auto = !language || language === "auto";
  const seconds =
    Number.isFinite(final?.languageAudioSeconds) && final.languageAudioSeconds > 0
      ? final.languageAudioSeconds
      : null;
  const score = validScore(final?.languageSupportedScore) ? final.languageSupportedScore : null;
  const topLanguage =
    typeof final?.language === "string" && /^[a-z]{2}$/.test(final.language)
      ? final.language
      : null;
  const topScore = validScore(final?.languageConfidence) ? final.languageConfidence : null;
  const eligible = auto && final?.success !== false && seconds >= 6 && score !== null;
  const candidate030 = eligible ? score <= 0.3 : null;
  const candidate010 = eligible ? score <= 0.1 : null;
  const candidate = mode === "supported-0.30" ? candidate030 : candidate010;
  const fallback = mode === "shadow" || candidate === null ? legacyFallback : candidate;

  // Explicit allowlist: never spread a final result, settings, transcript,
  // recording, token, account identifier or arbitrary server fields into logs.
  return {
    fallback,
    comparison: {
      version: 1,
      mode,
      auto,
      eligible,
      analyzedSeconds: seconds,
      topLanguage,
      topScore,
      supportedScore: score,
      legacyFallback,
      top05Fallback:
        auto &&
        final?.success !== false &&
        seconds >= 6 &&
        topLanguage !== null &&
        !isOrukeetLanguage(topLanguage) &&
        topScore !== null &&
        topScore >= 0.5,
      candidate030,
      candidate010,
      selectedFallback: fallback,
    },
  };
}

// Reported for every Orukeet dictation so the backend's per-user gate sees
// what was spoken. No `language` key means an older gateway or no final:
// nothing is reported, since "unknown" would misstate the detector.
export function orukeetDetectedLanguageFields(final) {
  if (!final || !("language" in final)) return {};
  if (typeof final.language !== "string") return { sttDetectedLanguageStatus: "unknown" };
  return {
    sttDetectedLanguage: final.language,
    sttDetectedLanguageConfidence: final.languageConfidence,
    ...(Number.isFinite(final.languageAudioSeconds)
      ? { sttDetectedLanguageAudioSeconds: final.languageAudioSeconds }
      : {}),
    sttDetectedLanguageStatus: "detected",
  };
}

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
  return isOrukeetLanguage(language) ? "orukeet" : "language_unsupported";
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
