// v1 hears English only: Parakeet EN transcribes and Pocket speaks English.
const VOICE_LANGUAGES = new Set(["en", "auto"]);

/**
 * Pure precondition check for starting a hands-free voice session: language support,
 * the bundled VAD/Smart Turn/Pocket models, a downloaded Parakeet speech model, and
 * (for a local brain) a downloaded chat model. Checked in this order so the cheapest,
 * least surprising failure (language) is reported before anything else.
 */
function checkVoiceConversationReadiness({ modelStatus, speechModelDownloaded, language, brain }) {
  // Language first: no point downloading models the user can't use.
  if (!VOICE_LANGUAGES.has(language || "auto")) return { ready: false, reason: "language-unsupported" };
  if (!modelStatus.ready) {
    return {
      ready: false,
      reason: "voice-models-missing",
      missing: modelStatus.missing,
      missingBytes: modelStatus.missingBytes,
    };
  }
  if (!speechModelDownloaded) return { ready: false, reason: "speech-model-missing" };
  if (brain.mode === "local" && !brain.downloaded) return { ready: false, reason: "brain-not-downloaded" };
  return { ready: true };
}

module.exports = { checkVoiceConversationReadiness };
