const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const LISTENER_STARTUP_TIMEOUT_MS = 5000;

// Key state comes from an evdev reader (resources/linux-key-listener.c) that reads
// /dev/input directly, so it observes KEY_UP regardless of which window has focus
// and cannot miss a release. The ceiling for a genuinely stuck key is
// MAX_PUSH_DURATION_MS in windowManager, which owns push state; enforcing one here
// too would end the push by synthesizing a release, making a forced stop
// indistinguishable from the user letting go.
class LinuxKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "linux";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
    // READY is emitted even after denial; retain the diagnosis until app restart.
    this.permissionDenied = false;
    this.listeners = new Map(); // key string -> current reader generation
    this.readiness = new Map();
    // Reader cleanup must not erase a failed capability verdict. Only a
    // fresh reader reaching READY can restore it.
    this.failedKeys = new Set();
    this.nextGeneration = 1;
  }

  /**
   * Reconcile the watched keys to exactly `keys`: spawn a listener for each new
   * key, stop listeners no longer wanted. Idempotent — safe to call repeatedly.
   */
  setKeys(keys) {
    if (!this.isSupported) return;
    const desired = new Set(keys.filter(Boolean));
    for (const key of this.readiness.keys()) {
      if (!desired.has(key)) this._stopKey(key);
    }
    for (const key of desired) {
      if (!this.readiness.has(key) && !this.failedKeys.has(key)) this._startKey(key);
    }
  }

  canWatch(key) {
    return this.isSupported && this.isAvailable() && !this.failedKeys.has(key);
  }

  async ensureReady(keys) {
    if (!this.isSupported) return false;
    const attempts = [...new Set(keys.filter(Boolean))].map((key) => {
      if (this.readiness.get(key)?.state === "failed") this._stopKey(key);
      const entry = this.readiness.get(key) || this._startKey(key);
      return entry.promise;
    });
    return (await Promise.all(attempts)).every(Boolean);
  }

  isCurrentFailure({ key, generation }) {
    const entry = this.readiness.get(key);
    return entry?.generation === generation && entry.state === "failed";
  }

  _startKey(key) {
    let resolveReady;
    const entry = {
      generation: this.nextGeneration++,
      state: "pending",
      child: null,
      timer: null,
      promise: new Promise((resolve) => {
        resolveReady = resolve;
      }),
      resolve: (ready) => resolveReady(ready),
    };
    this.readiness.set(key, entry);
    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      const error = new Error("Linux key listener binary not found");
      this._failKey(key, entry, error);
      if (!this.hasReportedUnavailable) {
        this.hasReportedUnavailable = true;
        this.emit("unavailable", error);
      }
      return entry;
    }

    try {
      entry.child = spawn(listenerPath, [key], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this._failKey(key, entry, error);
      this.reportError(error);
      return entry;
    }

    const child = entry.child;
    this.hasReportedError = false;
    this.listeners.set(key, entry);
    entry.timer = setTimeout(() => {
      const error = new Error("Linux key listener did not become ready");
      this._failKey(key, entry, error);
      this.reportError(error);
    }, LISTENER_STARTUP_TIMEOUT_MS);
    debugLogger.debug("[LinuxKeyManager] Starting key listener", { key, binaryPath: listenerPath });

    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.listeners.get(key) !== entry) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (line) this.handleOutputLine(line, key, entry);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      if (this.listeners.get(key) !== entry) return;
      const message = data.toString().trim();
      if (message) debugLogger.debug("[LinuxKeyManager] Native stderr", { key, message });
    });
    child.on("error", (error) => {
      if (this.listeners.get(key) !== entry) return;
      this._failKey(key, entry, error);
      this.reportError(error);
    });
    child.on("exit", (code, signal) => {
      if (this.listeners.get(key) !== entry) return;
      const trailingLine = lineBuffer.trim();
      if (trailingLine) this.handleOutputLine(trailingLine, key, entry);
      const error = new Error(
        `Linux key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
      );
      this._failKey(key, entry, error);
      this.reportError(error);
    });
    return entry;
  }

  _failKey(key, entry, error) {
    if (this.readiness.get(key) !== entry || entry.state === "failed") return;
    entry.state = "failed";
    this.failedKeys.add(key);
    clearTimeout(entry.timer);
    entry.resolve(false);
    this.listeners.delete(key);
    try {
      entry.child?.kill();
    } catch {
      /* Already gone. */
    }
    // Unlike the log warning, lifecycle failures must be delivered for every key.
    this.emit("failed", { key, generation: entry.generation, error });
  }

  _stopKey(key) {
    const entry = this.readiness.get(key);
    if (!entry) return;
    this.readiness.delete(key);
    this.listeners.delete(key);
    clearTimeout(entry.timer);
    entry.resolve(false);
    try {
      entry.child?.kill();
    } catch {
      /* Already gone. */
    }
  }

  handleOutputLine(line, key, entry = this.readiness.get(key)) {
    // Permission is a property of this process, not of one reader generation:
    // a denial from a stale or already-failed reader is still true, so record
    // it before ignoring the reader's lifecycle output.
    if (line === "NO_PERMISSION") this.permissionDenied = true;
    if (!entry || this.listeners.get(key) !== entry || entry.state === "failed") return;
    if (line === "READY") {
      if (entry.state === "ready") return;
      entry.state = "ready";
      this.failedKeys.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(true);
      this.emit("ready", key);
      return;
    }
    if (line === "NO_PERMISSION") {
      const error = new Error("No permission to access Linux input devices");
      this._failKey(key, entry, error);
      this.emit("permission-denied", key);
      return;
    }

    if (line === "KEY_DOWN" || line === "KEY_UP") {
      this.emit(line === "KEY_DOWN" ? "key-down" : "key-up", key);
      return;
    }
    debugLogger.debug("[LinuxKeyManager] Unknown output", { key, line });
  }

  stop() {
    for (const key of this.readiness.keys()) this._stopKey(key);
  }

  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  reportError(error) {
    if (this.hasReportedError) return;
    this.hasReportedError = true;
    debugLogger.warn("[LinuxKeyManager] Error occurred", { error: error.message });
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  resolveListenerBinary() {
    const arch = process.arch;
    const binaryNameWithArch = `linux-key-listener-${arch}`;
    const binaryNameNoArch = "linux-key-listener";

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryNameWithArch),
      path.join(__dirname, "..", "..", "resources", binaryNameWithArch),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryNameWithArch),
        path.join(process.resourcesPath, "bin", binaryNameWithArch),
        path.join(process.resourcesPath, "resources", binaryNameWithArch),
        path.join(process.resourcesPath, "resources", "bin", binaryNameWithArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryNameWithArch),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "resources",
          "bin",
          binaryNameWithArch
        ),
      ].forEach((candidate) => candidates.add(candidate));
    }

    [
      path.join(__dirname, "..", "..", "resources", "bin", binaryNameNoArch),
      path.join(__dirname, "..", "..", "resources", binaryNameNoArch),
    ].forEach((candidate) => candidates.add(candidate));

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryNameNoArch),
        path.join(process.resourcesPath, "bin", binaryNameNoArch),
        path.join(process.resourcesPath, "resources", binaryNameNoArch),
        path.join(process.resourcesPath, "resources", "bin", binaryNameNoArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryNameNoArch),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryNameNoArch),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of [...candidates]) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = LinuxKeyManager;
