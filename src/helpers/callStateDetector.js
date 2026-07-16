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
const { resolveBinaryPath } = require("../utils/serverUtils");

const ACTIVATE_DEBOUNCE_MS = 2500; // avoid firing on brief device blips
const DEACTIVATE_DEBOUNCE_MS = 8000; // survive short device flaps mid-call
// While WE are recording, our own capture holds the mic device, so the mic
// signal can no longer tell us the call ended. End detection then polls the
// camera (only the call holds it) and the meeting URL instead.
const END_POLL_MS = 12000;
const END_MISS_THRESHOLD = 2; // ~24s of "not in call" before auto-stop

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
  }

  _binaryPath() {
    if (process.platform !== "darwin") return null; // CoreMediaIO/CoreAudio only
    return resolveBinaryPath("macos-call-detector");
  }

  start() {
    if (this.proc) return;
    const binaryPath = this._binaryPath();
    if (!binaryPath) {
      debugLogger.warn(
        "call-detector binary not found; camera/mic-in-use detection disabled",
        {},
        "meeting"
      );
      return;
    }
    try {
      this.proc = spawn(binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      debugLogger.warn("Failed to spawn call-detector", { error: err.message }, "meeting");
      this.proc = null;
      return;
    }
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (d) =>
      debugLogger.debug("call-detector stderr", { msg: d.toString().trim() }, "meeting")
    );
    this.proc.on("close", (code) => {
      debugLogger.debug("call-detector exited", { code }, "meeting");
      this.proc = null;
    });
    this.proc.on("error", (err) => {
      debugLogger.warn("call-detector process error", { error: err.message }, "meeting");
      this.proc = null;
    });
    debugLogger.info("Call-state detector started", { binaryPath }, "meeting");
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
  }
}

module.exports = CallStateDetector;
