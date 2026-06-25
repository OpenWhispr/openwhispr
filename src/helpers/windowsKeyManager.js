/**
 * WindowsKeyManager - Detects key up/down for global hotkeys on Windows
 *
 * Modifier-only and right-side-modifier hotkeys can't register through Electron's
 * globalShortcut, so each one is watched by a native low-level keyboard hook. One
 * hook process is spawned per watched key; key-down/key-up events are emitted
 * tagged with the key so the caller can route them to the right hotkey slot
 * (dictation, voice agent, agent, meeting) and drive push-to-talk.
 */

const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class WindowsKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "win32";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
    this.listeners = new Map(); // key string -> child process
  }

  /**
   * Reconcile the watched keys to exactly `keys`: spawn a listener for each new
   * key, stop listeners no longer wanted. Idempotent — safe to call repeatedly.
   */
  setKeys(keys) {
    if (!this.isSupported) return;
    const desired = new Set(keys.filter(Boolean));

    for (const key of [...this.listeners.keys()]) {
      if (!desired.has(key)) this._stopKey(key);
    }

    if (desired.size === 0) return;

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      // Binary not found - this is OK, Push-to-Talk will use fallback mode
      if (!this.hasReportedUnavailable) {
        this.hasReportedUnavailable = true;
        this.emit("unavailable", new Error("Windows key listener binary not found"));
      }
      return;
    }

    for (const key of desired) {
      if (!this.listeners.has(key)) this._startKey(key, listenerPath);
    }
  }

  _startKey(key, listenerPath) {
    let child;
    try {
      child = spawn(listenerPath, [key], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      debugLogger.error("[WindowsKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error);
      return;
    }

    this.hasReportedError = false;
    this.listeners.set(key, child);
    debugLogger.debug("[WindowsKeyManager] Starting key listener", {
      key,
      binaryPath: listenerPath,
    });

    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (line) this.handleOutputLine(line, key);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        // Native binary logs to stderr for info messages, don't treat as error
        debugLogger.debug("[WindowsKeyManager] Native stderr", { key, message });
      }
    });

    child.on("error", (error) => {
      if (this.listeners.get(key) === child) this.listeners.delete(key);
      this.reportError(error);
    });

    child.on("exit", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine) this.handleOutputLine(trailingLine, key);

      // wasTracked is false for intentional stops (_stopKey deletes first), so this
      // reports only unexpected exits — including signal crashes, where code is null.
      const wasTracked = this.listeners.get(key) === child;
      if (wasTracked) this.listeners.delete(key);
      if (wasTracked && (code || signal)) {
        this.reportError(
          new Error(
            `Windows key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          )
        );
      }
    });
  }

  _stopKey(key) {
    const child = this.listeners.get(key);
    if (!child) return;
    this.listeners.delete(key);
    debugLogger.debug("[WindowsKeyManager] Stopping key listener", { key });
    try {
      child.kill();
    } catch {
      // Already gone
    }
  }

  handleOutputLine(line, key) {
    if (line === "READY") {
      debugLogger.debug("[WindowsKeyManager] Listener ready", { key });
      this.emit("ready", key);
      return;
    }

    if (line === "KEY_DOWN") {
      debugLogger.debug("[WindowsKeyManager] KEY_DOWN detected", { key });
      this.emit("key-down", key);
      return;
    }

    if (line === "KEY_UP") {
      debugLogger.debug("[WindowsKeyManager] KEY_UP detected", { key });
      this.emit("key-up", key);
      return;
    }

    debugLogger.debug("[WindowsKeyManager] Unknown output", { key, line });
  }

  /**
   * Stop all key listeners.
   */
  stop() {
    for (const key of [...this.listeners.keys()]) this._stopKey(key);
  }

  /**
   * Check if the listener binary is available
   */
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
    this.emit("error", error);
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
