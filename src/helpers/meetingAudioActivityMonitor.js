const {
  computePcm16Rms,
  MEETING_MIC_ACTIVITY_RMS,
  MEETING_SYSTEM_ACTIVITY_RMS,
} = require("../utils/audioUtils");

// How long a channel stays "active" after its last audible chunk. Both tails sit
// in front of the auto-end dwell, so they are kept short; the system tail only
// has to bridge the pause between a remote speaker's words, not their sentences.
const MIC_ACTIVITY_TAIL_MS = 2_000;
const SYSTEM_ACTIVITY_TAIL_MS = 1_000;

const CHANNELS = {
  mic: { threshold: MEETING_MIC_ACTIVITY_RMS, tailMs: MIC_ACTIVITY_TAIL_MS },
  system: { threshold: MEETING_SYSTEM_ACTIVITY_RMS, tailMs: SYSTEM_ACTIVITY_TAIL_MS },
};

// Energy-based activity per meeting channel. Timer-free: the owner feeds every
// PCM chunk through recordChunk() and drives evaluation with a ~1s tick().
// Activity is judged from sample energy, never from chunk arrival — the
// Windows loopback helper streams digital-zero silence continuously.
const createMeetingAudioActivityMonitor = ({ onActivityChanged = () => {} } = {}) => {
  const pending = { mic: false, system: false };
  const lastActiveAt = { mic: null, system: null };
  const active = { mic: false, system: false };

  const getState = () => ({ micActive: active.mic, systemActive: active.system });

  const reset = () => {
    for (const source of Object.keys(CHANNELS)) {
      pending[source] = false;
      lastActiveAt[source] = null;
      active[source] = false;
    }
  };

  // Hot path — runs for every chunk of both channels. Once a chunk in the
  // current tick has crossed the threshold there is nothing left to learn, so
  // the RMS pass is skipped until the next tick clears the flag.
  const recordChunk = (source, buffer) => {
    const channel = CHANNELS[source];
    if (!channel || pending[source]) return;
    pending[source] = computePcm16Rms(buffer) >= channel.threshold;
  };

  const tick = (nowMs) => {
    let changed = false;
    for (const [source, channel] of Object.entries(CHANNELS)) {
      if (pending[source]) {
        pending[source] = false;
        lastActiveAt[source] = nowMs;
      }
      const nextActive =
        lastActiveAt[source] !== null && nowMs - lastActiveAt[source] < channel.tailMs;
      if (nextActive !== active[source]) {
        active[source] = nextActive;
        changed = true;
      }
    }
    if (changed) onActivityChanged(getState());
  };

  return { recordChunk, tick, reset, getState };
};

module.exports = {
  createMeetingAudioActivityMonitor,
  MIC_ACTIVITY_TAIL_MS,
  SYSTEM_ACTIVITY_TAIL_MS,
};
