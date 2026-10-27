const {
  computeChunkStats,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");

const CONFIRM_MS = 1_000;

const isAudible = (buffer) => {
  const { rms, peak } = computeChunkStats(buffer);
  return rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
};

// capture_silent can also fire while the Windows helper is capturing the call
// fine (a hidden stream playing through a lull). Renderer loopback only hears
// the default output device, so it runs beside the helper and takes the system
// channel only after hearing audio the helper missed for CONFIRM_MS.
const createMeetingSystemAudioHandover = ({ now = Date.now } = {}) => {
  let phase = "native";
  let missedSince = null;

  return {
    begin: () => {
      if (phase !== "native") return false;
      phase = "trial";
      return true;
    },
    acceptNativeChunk: (buffer) => {
      if (phase === "renderer") return false;
      if (phase === "trial" && isAudible(buffer)) missedSince = null;
      return true;
    },
    acceptRendererChunk: (buffer) => {
      if (phase !== "trial") return "send";
      if (!isAudible(buffer)) return "drop";
      const at = now();
      missedSince ??= at;
      if (at - missedSince < CONFIRM_MS) return "drop";
      phase = "renderer";
      return "takeover";
    },
    reset: () => {
      phase = "native";
      missedSince = null;
    },
  };
};

module.exports = createMeetingSystemAudioHandover;
module.exports.CONFIRM_MS = CONFIRM_MS;
