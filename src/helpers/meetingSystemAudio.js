// Capture strategies that run in a helper process (macOS CoreAudio tap,
// Windows WASAPI process loopback, Linux PipeWire portal). Chromium's
// display-media loopback ("loopback") instead delivers mic and system chunks
// from the same renderer, already aligned.
const HELPER_CAPTURE_STRATEGIES = new Set(["native", "wasapi-loopback", "pipewire-loopback"]);

// A helper delivers system audio on its own schedule, so mic chunks must wait
// for the reference to catch up before the echo detector can correlate them.
// Keying this off the capability mode instead of the strategy silently
// disabled alignment on Windows and Linux, where the mode is "loopback" for
// both the helper and the renderer path.
const requiresMicReferenceAlignment = (strategy) => HELPER_CAPTURE_STRATEGIES.has(strategy);

const SYSTEM_AUDIO_SILENCE_GRACE_MS = 60000;
// Same audibility floor the echo detector uses for its system-side VAD.
const AUDIBLE_SYSTEM_RMS = 0.004;

// The Windows and Linux helpers pad the stream with silence whenever no
// application is rendering, so a dead capture and a quiet meeting look
// identical by byte count. Report once when a full grace period of system
// audio arrives without a single audible chunk.
class SystemAudioSilenceMonitor {
  constructor({ graceMs = SYSTEM_AUDIO_SILENCE_GRACE_MS, audibleRms = AUDIBLE_SYSTEM_RMS } = {}) {
    this.graceMs = graceMs;
    this.audibleRms = audibleRms;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.heardAudio = false;
    this.reported = false;
  }

  record(rms, timestampMs) {
    if (this.startedAt === null) {
      this.startedAt = timestampMs;
    }
    if (rms >= this.audibleRms) {
      this.heardAudio = true;
      return false;
    }
    if (this.heardAudio || this.reported || timestampMs - this.startedAt < this.graceMs) {
      return false;
    }
    this.reported = true;
    return true;
  }
}

module.exports = {
  requiresMicReferenceAlignment,
  SystemAudioSilenceMonitor,
  SYSTEM_AUDIO_SILENCE_GRACE_MS,
};
