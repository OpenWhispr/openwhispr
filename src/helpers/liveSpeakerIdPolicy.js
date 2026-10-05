// Whether live speaker identification can run for the given meeting system
// audio mode.
//
// "native" (macOS Core Audio tap) and Windows "loopback" (WASAPI helper or
// renderer display-media fallback) all deliver 24 kHz mono s16le PCM through
// the same sendMeetingAudio("system") path, so the identifier works unchanged.
// Linux reports "loopback" too (PipeWire portal) but that capture path has not
// been verified against the identifier yet, so it stays disabled.
export function supportsLiveSpeakerIdentification(systemAudioMode, platform = process.platform) {
  if (systemAudioMode === "native") return true;
  return systemAudioMode === "loopback" && platform === "win32";
}
