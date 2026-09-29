// v1 hears English only: Parakeet EN transcribes, and Supertonic speaks with an English voice.
const VOICE_LANGUAGES = new Set(["en", "auto"]);

/**
 * Pure precondition check for starting a hands-free voice session: language support,
 * the bundled VAD/Smart Turn/Supertonic models, a downloaded Parakeet speech model, and a
 * brain that can answer (a downloaded local model, OpenWhispr Cloud while signed in, or
 * a BYOK provider with its API key).
 * Checked in this order so the cheapest, least surprising failure (language) is
 * reported before anything else.
 */
function checkVoiceConversationReadiness({
  meetingRecording = false,
  modelStatus,
  speechModelDownloaded,
  language,
  brain,
}) {
  // A meeting recording holds the mic, and the assistant would answer the meeting.
  if (meetingRecording) return { ready: false, reason: "meeting-recording" };
  // Language first: no point downloading models the user can't use.
  if (!VOICE_LANGUAGES.has(language || "auto"))
    return { ready: false, reason: "language-unsupported" };
  if (!modelStatus.ready) {
    return {
      ready: false,
      reason: "voice-models-missing",
      missing: modelStatus.missing,
      missingBytes: modelStatus.missingBytes,
    };
  }
  if (!speechModelDownloaded) return { ready: false, reason: "speech-model-missing" };
  if (brain.mode === "local" && !brain.downloaded)
    return { ready: false, reason: "brain-not-downloaded" };
  if (brain.mode === "openwhispr" && !brain.signedIn) {
    return { ready: false, reason: "brain-sign-in-required" };
  }
  if (brain.keyMissing) return { ready: false, reason: "brain-key-missing" };
  return { ready: true };
}

module.exports = { checkVoiceConversationReadiness };
