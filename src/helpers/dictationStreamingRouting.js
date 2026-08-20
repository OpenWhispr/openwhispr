// Single source of truth for dictation/notes realtime STT routing: which
// streaming provider a settings state resolves to, and the exact session
// options every provider receives over IPC. Provider facts scattered across
// call sites is what broke default dictation in 1.8.2 (#1624: the
// openai-realtime entry never sent `provider`, and the hardened main-process
// allowlist rejected undefined). Pure module, mirrors meetingTranscriptionRouting.

export const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

export function defaultStreamingProviderName(context) {
  return context === "notes" ? "deepgram" : "openai-realtime";
}

export function resolveStreamingProviderName({ settings, context, sttConfig }) {
  if (settings.cloudTranscriptionProvider === "tinfoil") {
    return "tinfoil-realtime";
  }
  if (
    settings.cloudTranscriptionProvider === "corti" &&
    settings.cloudTranscriptionMode === "byok"
  ) {
    return "corti";
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
  return options;
}
