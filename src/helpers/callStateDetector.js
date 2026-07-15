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
    this.state = { camera: false, microphone: false };
  }
}

module.exports = CallStateDetector;
