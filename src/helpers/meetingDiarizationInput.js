/**
 * Pure input-selection policy for post-meeting diarization.
 *
 * A meeting session records two parallel raw PCM captures: the system-audio
 * tap (calls) and the microphone (in-person sessions, kept only until system
 * audio turns audible). At stop, exactly one of them feeds the diarizer and
 * the other is deleted. Call sessions keep today's behavior: any session that
 * heard audible system audio diarizes the system channel.
 */
function resolveDiarizationInput({
  systemPcmPath = null,
  micPcmPath = null,
  systemAudioHeard = false,
  systemStartedAt = null,
  micStartedAt = null,
} = {}) {
  if (systemAudioHeard || !micPcmPath) {
    return {
      pcmPath: systemPcmPath,
      startedAt: systemStartedAt,
      diarizedSource: "system",
      cleanupPcmPaths: micPcmPath ? [micPcmPath] : [],
    };
  }

  return {
    pcmPath: micPcmPath,
    startedAt: micStartedAt,
    diarizedSource: "mic",
    cleanupPcmPaths: systemPcmPath ? [systemPcmPath] : [],
  };
}

module.exports = { resolveDiarizationInput };
