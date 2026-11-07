const { CALL_LANGUAGES } = require("./voiceConversationConfig");

/**
 * Pure precondition check for starting a voice call: the call language, the
 * VAD/Smart Turn/Supertonic models, a downloaded speech model that knows the
 * language, and a brain that can answer (a downloaded local model, OpenWhispr
 * Cloud while signed in, or a BYOK provider with its API key).
 * Checked in this order so the cheapest, least surprising failure is reported
 * before anything that needs a download.
 */
function checkVoiceConversationReadiness({
  meetingRecording = false,
  modelStatus,
  recognizer,
  language,
  brain,
}) {
  // A meeting recording holds the mic, and the assistant would answer the meeting.
  if (meetingRecording) return { ready: false, reason: "meeting-recording" };
  if (!CALL_LANGUAGES.includes(language)) return { ready: false, reason: "language-unsupported" };
  if (!modelStatus.ready) {
    return {
      ready: false,
      reason: "voice-models-missing",
      missing: modelStatus.missing,
      missingBytes: modelStatus.missingBytes,
    };
  }
  if (!recognizer) {
    // English and Auto take any local Parakeet model; another language needs one that knows it.
    return {
      ready: false,
      reason:
        language === "en" || language === "auto"
          ? "speech-model-missing"
          : "language-model-missing",
    };
  }
  if (brain.mode === "local" && !brain.downloaded)
    return { ready: false, reason: "brain-not-downloaded" };
  if (brain.mode === "openwhispr" && !brain.signedIn) {
    return { ready: false, reason: "brain-sign-in-required" };
  }
  if (brain.keyMissing) return { ready: false, reason: "brain-key-missing" };
  return { ready: true };
}

module.exports = { checkVoiceConversationReadiness };
