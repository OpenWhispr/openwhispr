/**
 * WindowsKeyManager - Detects key up/down for global hotkeys on Windows
 *
 * Modifier-only and right-side-modifier hotkeys can't register through Electron's
 * globalShortcut, so each one is watched by a native low-level keyboard hook. One
 * hook process is spawned per watched key; key-down/key-up events are emitted
 * tagged with the key so the caller can route them to the right hotkey slot
 * (dictation, voice assistant, translation, meeting) and drive push-to-talk.
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const EXACT_MODIFIERS_FLAG = "--exact-modifiers";
const EXACT_MODIFIERS_PROBE = "--supports-exact-modifiers";
const EXACT_MODIFIERS_READY = "EXACT_MODIFIERS_READY";

class WindowsKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "win32";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
    this.listeners = new Map(); // key string -> { child, exact }
    this.exactModifiersProbe = null;
  }

  /**
   * Reconcile the watched keys to exactly `keys`: spawn a listener for each new
   * key, stop listeners no longer wanted. Idempotent — safe to call repeatedly.
   */
  setKeys(keys, { exactKeys = [] } = {}) {
    if (!this.isSupported) return;
    const desired = new Set(keys.filter(Boolean));
    const strict = new Set(exactKeys);

    for (const [key, listener] of this.listeners) {
      if (!desired.has(key) || listener.exact !== strict.has(key)) this._stopKey(key);
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
      if (!this.listeners.has(key)) this._startKey(key, listenerPath, strict.has(key));
    }
  }

  _startKey(key, listenerPath, exact) {
    const args = exact ? [key, EXACT_MODIFIERS_FLAG] : [key];
    let child;
    try {
      child = spawn(listenerPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      debugLogger.error("[WindowsKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error, exact ? key : undefined);
      return;
    }

    this.hasReportedError = false;
    const entry = { child, exact };
    this.listeners.set(key, entry);
    debugLogger.debug("[WindowsKeyManager] Starting key listener", {
      key,
      binaryPath: listenerPath,
    });

    let exactReady = false;
    const dispatch = (line) => {
      if (exact && line === EXACT_MODIFIERS_READY) {
        exactReady = true;
        this.handleOutputLine("READY", key);
      } else if (exact && !exactReady && line === "READY") {
        this.exactModifiersProbe = { binary: listenerPath, supported: false };
        this._stopKey(key);
        const error = new Error("Windows key listener does not support exact modifiers");
        error.code = "exact_modifiers_unavailable";
        this.reportError(error, exact ? key : undefined);
      } else if (!exact || exactReady) {
        this.handleOutputLine(line, key, exactReady ? { exactModifiers: true } : undefined);
      }
    };

    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.listeners.get(key) !== entry) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        if (this.listeners.get(key) !== entry) return;
        const line = raw.trim();
        if (line) dispatch(line);
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
      if (this.listeners.get(key) !== entry) return;
      this.listeners.delete(key);
      this.reportError(error, exact ? key : undefined);
    });

    // exit can precede the final KEY_UP on stdout; close waits for the pipe to drain.
    child.on("close", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine && this.listeners.get(key) === entry) {
        dispatch(trailingLine);
      }

      // Intentional stops untrack the child first. Even a clean exit can leave
      // hands-free dictation without its stop shortcut.
      const wasTracked = this.listeners.get(key) === entry;
      if (wasTracked) this.listeners.delete(key);
      if (wasTracked && (exact || code || signal)) {
        this.reportError(
          new Error(
            `Windows key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          ),
          exact ? key : undefined
        );
      }
    });
  }

  _stopKey(key) {
    const entry = this.listeners.get(key);
    if (!entry) return;
    this.listeners.delete(key);
    debugLogger.debug("[WindowsKeyManager] Stopping key listener", { key });
    try {
      entry.child.kill();
    } catch {
      // Already gone
    }
  }

  handleOutputLine(line, key, metadata) {
    if (line === "READY") {
      debugLogger.debug("[WindowsKeyManager] Listener ready", { key });
      this.emit("ready", key);
      return;
    }

    if (line === "KEY_DOWN") {
      this.emit("key-down", key, metadata);
      return;
    }

    if (line === "KEY_UP") {
      this.emit("key-up", key, metadata);
      return;
    }

    if (line === "KEY_INTERRUPTED" && metadata?.exactModifiers) {
      this.emit("key-interrupted", key, metadata);
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

  // Same shape as LinuxKeyManager.checkAvailability, for HotkeyManager's probe.
  checkAvailability() {
    return this.isAvailable()
      ? { available: true }
      : { available: false, reason: "binary_missing" };
  }

  reportError(error, exactKey) {
    // Every exact listener loss must reach the recording lifecycle.
    if (this.hasReportedError && !exactKey) return;
    this.hasReportedError = true;
    debugLogger.warn("[WindowsKeyManager] Error occurred", { error: error.message });
    this.emit("error", error, exactKey);
  }

  supportsExactModifiers() {
    const binary = this.resolveListenerBinary();
    if (!binary) return false;
    if (this.exactModifiersProbe?.binary !== binary) {
      // The probe exits before installing a hook or opening input devices.
      const result = spawnSync(binary, [EXACT_MODIFIERS_PROBE], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      this.exactModifiersProbe = {
        binary,
        supported: result.status === 0 && result.stdout?.trim() === EXACT_MODIFIERS_READY,
      };
    }
    return this.exactModifiersProbe.supported;
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
