/**
 * CallStateDetector
 *
 * Wraps the native `macos-call-detector` binary, which reports camera/microphone
 * device-in-use transitions (i.e. "you're actually in a call"). Debounces the
 * signal, optionally confirms via a browser meeting-URL check, and emits:
 *   - "call-active"  { devices: {camera, microphone}, urlMatch }
 *   - "call-ended"
 *
 * This is a stronger "in a call" signal than audio energy: it fires even when
 * you're muted (the call still holds the mic/camera device), and it does NOT
 * fire just because a meeting tab is open (no device is claimed until you join).
 */
const { spawn } = require("child_process");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const health = require("./meetingDetectionHealth");
const { resolveBinaryPath } = require("../utils/serverUtils");

const ACTIVATE_DEBOUNCE_MS = 2500; // avoid firing on brief device blips
const DEACTIVATE_DEBOUNCE_MS = 8000; // survive short device flaps mid-call
// While WE are recording, our own capture holds the mic device, so the mic
// signal can no longer tell us the call ended. End detection then polls the
// camera (only the call holds it) and the meeting URL instead.
const END_POLL_MS = 12000;
const END_MISS_THRESHOLD = 2; // ~24s of "not in call" before auto-stop
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 60 * 1000;
const RESTART_MAX_ATTEMPTS = 5;

class CallStateDetector extends EventEmitter {
  constructor({ urlChecker = null } = {}) {
    super();
    this.urlChecker = urlChecker; // async () => { matched, url, browser }
    this.proc = null;
    this.buffer = "";
    this.state = { camera: false, microphone: false };
    this._activateTimer = null;
    this._deactivateTimer = null;
    this._callActive = false;
    this._selfRecording = false; // true while OUR recording is holding the mic
    this._callUsedCamera = false;
    this._endPollTimer = null;
    this._endMisses = 0;
    this._running = false;
    this._restartTimer = null;
    this._restartAttempts = 0;
  }

  _binaryPath() {
    if (process.platform !== "darwin") return null; // CoreMediaIO/CoreAudio only
    return resolveBinaryPath("macos-call-detector");
  }

  start() {
    if (this.proc) return;
    this._running = true;
    const binaryPath = this._binaryPath();
    if (!binaryPath) {
      debugLogger.warn(
        "call-detector binary not found; camera/mic-in-use detection disabled",
        {},
        "meeting"
      );
      health.setMode("call", "unavailable", { reason: "binary-not-found" });
      return;
    }
    this._spawnDetector(binaryPath);
  }

  _spawnDetector(binaryPath = this._binaryPath()) {
    if (!binaryPath) {
      health.setMode("call", "unavailable", { reason: "binary-not-found" });
      return null;
    }
    try {
      this.proc = spawn(binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      debugLogger.warn("Failed to spawn call-detector", { error: err.message }, "meeting");
      this.proc = null;
      health.setMode("call", "unavailable", { reason: "spawn-failed" });
      this._scheduleRestart("spawn-failed");
      return null;
    }
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (d) =>
      debugLogger.debug("call-detector stderr", { msg: d.toString().trim() }, "meeting")
    );
    this.proc.on("close", (code) => this._onChildGone("close", code));
    this.proc.on("error", (err) => {
      debugLogger.warn("call-detector process error", { error: err.message }, "meeting");
      this._onChildGone("error", null);
    });
    health.setMode("call", "event-driven", { via: "macos-call-detector" });
    health.recordChild("call", { pid: this.proc.pid, alive: true });
    this._restartAttempts = 0;
    debugLogger.info("Call-state detector started", { binaryPath }, "meeting");
    return this.proc;
  }

  // The detector's state is a mirror of the child's device reports. Once the child
  // is gone that mirror is stale, and stale "camera still on" would swallow the
  // next call's start as well as its end.
  _onChildGone(kind, code) {
    debugLogger.warn("call-detector exited", { kind, code }, "meeting");
    this.proc = null;
    this.buffer = "";
    this.state = { camera: false, microphone: false };
    this._callActive = false;
    this._callUsedCamera = false;
    if (this._activateTimer) {
      clearTimeout(this._activateTimer);
      this._activateTimer = null;
    }
    if (this._deactivateTimer) {
      clearTimeout(this._deactivateTimer);
      this._deactivateTimer = null;
    }
    health.recordChild("call", { alive: false, ...(code === null ? {} : { exitCode: code }) });
    health.setMode("call", "unavailable", { reason: `call-detector-${kind}` });
    this._scheduleRestart(`call-detector-${kind}`);
  }

  _scheduleRestart(reason) {
    if (this._restartTimer || !this._running) return;

    if (this._restartAttempts >= RESTART_MAX_ATTEMPTS) {
      debugLogger.error(
        "call-detector could not be restarted; giving up",
        { attempts: this._restartAttempts, reason },
        "meeting"
      );
      health.setMode("call", "unavailable", { reason: `unrecoverable:${reason}` });
      return;
    }

    this._restartAttempts += 1;
    const delayMs = Math.min(RESTART_BASE_MS * 2 ** (this._restartAttempts - 1), RESTART_MAX_MS);
    health.recordRestart("call", { attempt: this._restartAttempts, delayMs, reason });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._running || this.proc) return;
      this._spawnDetector();
      if (!this.proc) this._scheduleRestart(reason);
    }, delayMs);
    this._restartTimer?.unref?.();
  }

  revalidate(reason = "revalidate") {
    if (!this._running || this.proc) return;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartAttempts = 0;
    debugLogger.info("Revalidating call-state detector", { reason }, "meeting");
    this._spawnDetector();
    if (!this.proc) this._scheduleRestart(reason);
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        msg &&
        (msg.device === "camera" || msg.device === "microphone") &&
        typeof msg.active === "boolean"
      ) {
        this.state[msg.device] = msg.active;
        this._reconcile();
      }
    }
  }

  _anyActive() {
    return this.state.camera || this.state.microphone;
  }

  _reconcile() {
    if (this.state.camera) this._callUsedCamera = true;

    // While our own recording holds the mic, the device signal can't tell us the
    // call ended — end detection runs in _endPollTick() via setSelfRecording().
    if (this._selfRecording) return;

    if (this._anyActive()) {
      if (this._deactivateTimer) {
        clearTimeout(this._deactivateTimer);
        this._deactivateTimer = null;
      }
      if (!this._callActive && !this._activateTimer) {
        this._activateTimer = setTimeout(() => {
          this._activateTimer = null;
          this._fireActive().catch(() => {});
        }, ACTIVATE_DEBOUNCE_MS);
      }
    } else {
      if (this._activateTimer) {
        clearTimeout(this._activateTimer);
        this._activateTimer = null;
      }
      if (this._callActive && !this._deactivateTimer) {
        this._deactivateTimer = setTimeout(() => {
          this._deactivateTimer = null;
          this._callActive = false;
          this.emit("call-ended");
        }, DEACTIVATE_DEBOUNCE_MS);
      }
    }
  }

  async _fireActive() {
    if (this._callActive) return;
    const devices = { ...this.state };
    let urlMatch = null;
    if (this.urlChecker) {
      try {
        urlMatch = await this.urlChecker();
      } catch (err) {
        debugLogger.debug("Meeting URL check failed", { error: err.message }, "meeting");
      }
    }
    // The call may have ended during the async URL check.
    if (!this._anyActive()) return;
    this._callActive = true;
    this.emit("call-active", { devices, urlMatch });
  }

  isCallActive() {
    return this._callActive;
  }

  // The engine calls this when it auto-starts/stops a recording. While true, our
  // own capture holds the mic, so we switch end-detection to a poll (camera +
  // meeting URL) that isn't fooled by our own mic usage.
  setSelfRecording(active) {
    this._selfRecording = active;
    if (active) {
      this._startEndPoll();
    } else {
      this._stopEndPoll();
      this._callUsedCamera = false;
    }
  }

  _startEndPoll() {
    this._endMisses = 0;
    if (this._endPollTimer) return;
    this._endPollTimer = setInterval(() => {
      this._endPollTick().catch(() => {});
    }, END_POLL_MS);
  }

  _stopEndPoll() {
    if (this._endPollTimer) {
      clearInterval(this._endPollTimer);
      this._endPollTimer = null;
    }
    this._endMisses = 0;
  }

  async _endPollTick() {
    if (!this._selfRecording) return;
    let stillInCall;
    if (this._callUsedCamera) {
      // Video call: the camera is released the instant you leave, and we never
      // hold the camera ourselves — so it's the reliable end signal. (The URL
      // isn't: Meet's "you left" screen keeps the meeting-code URL.)
      stillInCall = this.state.camera;
    } else if (this.urlChecker) {
      // Audio-only / camera-off: fall back to whether a meeting URL is still open
      // (ends when the tab is closed/navigated away). The self-held mic is ignored.
      try {
        const match = await this.urlChecker();
        stillInCall = !!match?.matched;
      } catch {
        stillInCall = true; // on error, stay conservative and rely on the max cap
      }
    } else {
      stillInCall = true; // no usable signal — rely on the max-duration safety cap
    }
    if (stillInCall) {
      this._endMisses = 0;
      return;
    }
    this._endMisses += 1;
    if (this._endMisses >= END_MISS_THRESHOLD) {
      this._stopEndPoll();
      this._callActive = false;
      this._selfRecording = false;
      this._callUsedCamera = false;
      this.emit("call-ended");
    }
  }

  stop() {
    this._running = false;
    this._restartAttempts = 0;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._activateTimer) {
      clearTimeout(this._activateTimer);
      this._activateTimer = null;
    }
    if (this._deactivateTimer) {
      clearTimeout(this._deactivateTimer);
      this._deactivateTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    this._callActive = false;
    this._selfRecording = false;
    this._callUsedCamera = false;
    this._stopEndPoll();
    this.state = { camera: false, microphone: false };
    health.setMode("call", "stopped");
  }
}

module.exports = CallStateDetector;
