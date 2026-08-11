/**
 * MeetingDetectionHealth
 *
 * A passive registry of what the meeting-detection stack is currently doing.
 * Nothing here changes behaviour: detectors report their mode and their child
 * process, the engine reports why it dropped a detection, and Settings and the
 * log file can then answer "is detection working, and if not, why not?".
 *
 * Modes: "event-driven" (the good case), "polling" (degraded but working),
 * "unavailable" (cannot detect at all), "stopped" (off by preference).
 */

const RANK = { unavailable: 3, polling: 2, "event-driven": 1, stopped: 0 };
const MAX_RESTART_HISTORY = 10;

class MeetingDetectionHealth {
  constructor() {
    this.reset();
  }

  reset() {
    this.detectors = new Map();
    this.lastSuppression = null;
    this.suppressionCounts = {};
    this.latches = {};
  }

  _detector(name) {
    let detector = this.detectors.get(name);
    if (!detector) {
      detector = {
        name,
        mode: "stopped",
        reason: null,
        childPid: null,
        childAlive: false,
        lastExitCode: null,
        restartCount: 0,
        restarts: [],
        lastEventAt: null,
        updatedAt: null,
      };
      this.detectors.set(name, detector);
    }
    return detector;
  }

  setMode(name, mode, meta = {}) {
    const detector = this._detector(name);
    detector.mode = mode;
    detector.reason = meta.reason ?? (mode === "event-driven" ? null : detector.reason);
    if (meta.via) detector.via = meta.via;
    detector.updatedAt = Date.now();
    if (mode === "stopped") {
      detector.childPid = null;
      detector.childAlive = false;
    }
    return detector;
  }

  recordChild(name, { pid, alive, exitCode } = {}) {
    const detector = this._detector(name);
    if (pid !== undefined) detector.childPid = pid;
    if (alive !== undefined) detector.childAlive = alive;
    if (exitCode !== undefined) detector.lastExitCode = exitCode;
    detector.updatedAt = Date.now();
    return detector;
  }

  recordRestart(name, { attempt, delayMs, reason } = {}) {
    const detector = this._detector(name);
    detector.restartCount += 1;
    detector.restarts.push({ at: Date.now(), attempt: attempt ?? null, delayMs: delayMs ?? null, reason: reason ?? null });
    if (detector.restarts.length > MAX_RESTART_HISTORY) detector.restarts.shift();
    detector.updatedAt = Date.now();
    return detector;
  }

  recordEvent(name) {
    const detector = this._detector(name);
    detector.lastEventAt = Date.now();
    return detector;
  }

  recordSuppression(reason, meta = {}) {
    this.suppressionCounts[reason] = (this.suppressionCounts[reason] || 0) + 1;
    this.lastSuppression = { reason, at: Date.now(), ...meta };
    return this.lastSuppression;
  }

  setLatches(patch) {
    Object.assign(this.latches, patch);
  }

  // The worst mode any running detector is in decides the overall status: a mic
  // detector that cannot see the mic makes the whole stack unavailable, whatever
  // the process detector thinks.
  _worstDetector() {
    let worst = null;
    for (const detector of this.detectors.values()) {
      if (detector.mode === "stopped") continue;
      if (!worst || (RANK[detector.mode] ?? 0) > (RANK[worst.mode] ?? 0)) worst = detector;
    }
    return worst;
  }

  getStatus() {
    const worst = this._worstDetector();
    if (!worst) return "off";
    if (worst.mode === "unavailable") return "unavailable";
    if (worst.mode === "polling") return "degraded";
    return "healthy";
  }

  getSnapshot() {
    const worst = this._worstDetector();
    return {
      status: this.getStatus(),
      reason: worst?.reason ?? null,
      detectors: [...this.detectors.values()].map((detector) => ({ ...detector, restarts: [...detector.restarts] })),
      latches: { ...this.latches },
      suppressionCounts: { ...this.suppressionCounts },
      lastSuppression: this.lastSuppression ? { ...this.lastSuppression } : null,
    };
  }
}

const meetingDetectionHealth = new MeetingDetectionHealth();

module.exports = meetingDetectionHealth;
module.exports.MeetingDetectionHealth = MeetingDetectionHealth;
