/**
 * WindowsKeyManager - Detects key up/down for global hotkeys on Windows
 *
 * Modifier-only and right-side-modifier hotkeys can't register through Electron's
 * globalShortcut, so each one is watched by a native low-level keyboard hook. One
 * hook process is spawned per watched key; key-down/key-up events are emitted
 * tagged with the key so the caller can route them to the right hotkey slot
 * (dictation, voice assistant, translation, meeting) and drive push-to-talk.
 */

const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const LISTENER_STARTUP_TIMEOUT_MS = 5000;

class WindowsKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "win32";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
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
      const error = new Error("Windows key listener binary not found");
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
        windowsHide: true,
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
      const error = new Error("Windows key listener did not become ready");
      this._failKey(key, entry, error);
      this.reportError(error);
    }, LISTENER_STARTUP_TIMEOUT_MS);
    debugLogger.debug("[WindowsKeyManager] Starting key listener", {
      key,
      binaryPath: listenerPath,
    });

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
      if (message) debugLogger.debug("[WindowsKeyManager] Native stderr", { key, message });
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
        `Windows key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
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

    if (line === "KEY_DOWN" || line === "KEY_UP") {
      this.emit(line === "KEY_DOWN" ? "key-down" : "key-up", key);
      return;
    }
    debugLogger.debug("[WindowsKeyManager] Unknown output", { key, line });
  }

  stop() {
    for (const key of this.readiness.keys()) this._stopKey(key);
  }

  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  /**
   * Report an error (only once per session to avoid log spam)
   */
  reportError(error) {
    if (this.hasReportedError) return;
    this.hasReportedError = true;
    debugLogger.warn("[WindowsKeyManager] Error occurred", { error: error.message });
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  /**
   * Find the listener binary in various possible locations
   */
  resolveListenerBinary() {
    const binaryName = "windows-key-listener.exe";
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    const candidatePaths = [...candidates];

    for (const candidate of candidatePaths) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = WindowsKeyManager;
