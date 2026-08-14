const DEFAULTS = {
  // How long both channels must stay below their activity thresholds before
  // the "meeting seems over" prompt fires.
  silenceMs: 60_000,
  // Tightened window applied after the tracked meeting app exits: audio that
  // keeps flowing (browser meeting) cancels it before it ever prompts.
  fastSilenceMs: 10_000,
  // Mirrors MIN_RMS / MIN_SYSTEM_RMS in meetingEchoLeakDetector.js. The
  // Windows loopback helper streams digital-zero silence to keep the timeline
  // continuous, so activity must be judged from sample energy, never from
  // chunks arriving.
  micActivityRms: 0.006,
  systemActivityRms: 0.004,
  // Floor after "Keep recording" so a brief cough followed by renewed silence
  // doesn't re-prompt one minute later.
  keepCooldownMs: 300_000,
  // A tick gap larger than this means the machine slept; accumulated silence
  // predates the wake and must not fire a stop.
  clockJumpMs: 5_000,
};

// RMS over raw s16le PCM without the Float32Array conversion the echo-leak
// detector pays — this runs on every meeting chunk for the whole recording.
function computeRmsFromPcm16(buffer) {
  if (!buffer || buffer.length < 2) {
    return 0;
  }

  const sampleCount = buffer.length >> 1;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buffer.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }

  return Math.sqrt(sumSq / sampleCount);
}

// Pure silence state machine for meeting auto-stop. Clock-injected (every
// entry point takes nowMs) and timer-free: the owner feeds it per-chunk RMS
// via recordChunkRms() and drives evaluation with a ~1s tick(). Events:
//   - "silence-threshold-reached" { reason: "silence" | "process-exit" }
//   - "activity-resumed" (only while a prompt is outstanding)
class MeetingInactivityMonitor {
  constructor({ onEvent, ...overrides } = {}) {
    this.config = { ...DEFAULTS, ...overrides };
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.running = false;
    this._reset(0);
  }

  _reset(nowMs) {
    this.lastActivityAt = nowMs;
    this.lastTickAt = nowMs;
    this.activityPending = false;
    this.prompting = false;
    // After "Keep recording": no new prompt until activity is observed again,
    // so a genuinely quiet meeting is asked exactly once per silence episode.
    this.episodeConsumed = false;
    this.cooldownUntil = 0;
    this.fastArmAt = null;
  }

  start(nowMs) {
    this.running = true;
    this._reset(nowMs);
  }

  stop() {
    this.running = false;
    this._reset(0);
  }

  isPrompting() {
    return this.prompting;
  }

  // Hot path: one compare per chunk, no allocation. Evaluation happens in
  // tick(), never at chunk rate.
  recordChunkRms(source, rms) {
    if (!this.running) {
      return;
    }

    const threshold = source === "mic" ? this.config.micActivityRms : this.config.systemActivityRms;
    if (rms >= threshold) {
      this.activityPending = true;
    }
  }

  // Tracked meeting app exited: measure a short grace window from now instead
  // of the full silence window. Ongoing audio clears it silently.
  armFast(nowMs) {
    if (!this.running || this.prompting) {
      return;
    }

    this.fastArmAt = nowMs;
    // The exit is fresh evidence, so it opens a new episode even if the user
    // already kept through an earlier silence prompt — but the keep cooldown
    // still applies (they said "keep" moments ago; honor it).
    this.episodeConsumed = false;
  }

  keepRecording(nowMs) {
    if (!this.running) {
      return;
    }

    this.prompting = false;
    this.episodeConsumed = true;
    this.cooldownUntil = nowMs + this.config.keepCooldownMs;
    // Keeping after a process exit means the call continues elsewhere.
    this.fastArmAt = null;
  }

  tick(nowMs) {
    if (!this.running) {
      return;
    }

    const tickGap = nowMs - this.lastTickAt;
    this.lastTickAt = nowMs;

    if (tickGap > this.config.clockJumpMs) {
      // Slept through the gap; whatever silence accumulated is stale.
      this.lastActivityAt = nowMs;
      this.fastArmAt = null;
      this.activityPending = false;
      if (this.prompting) {
        this.prompting = false;
        this.onEvent("activity-resumed", { reason: "clock-jump" });
      }
      return;
    }

    if (this.activityPending) {
      this.activityPending = false;
      this.lastActivityAt = nowMs;
      this.fastArmAt = null;
      this.episodeConsumed = false;
      if (this.prompting) {
        this.prompting = false;
        this.onEvent("activity-resumed", { reason: "audio" });
      }
      return;
    }

    if (this.prompting || this.episodeConsumed || nowMs < this.cooldownUntil) {
      return;
    }

    const fastArmed = this.fastArmAt != null;
    const silenceStart = fastArmed
      ? Math.max(this.lastActivityAt, this.fastArmAt)
      : this.lastActivityAt;
    const window = fastArmed ? this.config.fastSilenceMs : this.config.silenceMs;

    if (nowMs - silenceStart >= window) {
      this.prompting = true;
      this.onEvent("silence-threshold-reached", {
        reason: fastArmed ? "process-exit" : "silence",
      });
    }
  }
}

module.exports = { MeetingInactivityMonitor, computeRmsFromPcm16, DEFAULTS };
