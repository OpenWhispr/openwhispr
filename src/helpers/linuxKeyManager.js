const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

// Force a key-up if the native listener never reports one (e.g. a missed release
// while another window had focus), so a held key can't get stuck recording.
const WATCHDOG_MS = 30000;

class LinuxKeyManager extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "linux";
    this.hasReportedError = false;
    this.hasReportedUnavailable = false;
    this.listeners = new Map(); // key string -> { child, watchdog }
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
      if (!this.hasReportedUnavailable) {
        this.hasReportedUnavailable = true;
        this.emit("unavailable", new Error("Linux key listener binary not found"));
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
      child = spawn(listenerPath, [key], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      debugLogger.error("[LinuxKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error);
      return;
    }

    this.hasReportedError = false;
    const entry = { child, watchdog: null };
    this.listeners.set(key, entry);
    debugLogger.debug("[LinuxKeyManager] Starting key listener", { key, binaryPath: listenerPath });

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
        debugLogger.debug("[LinuxKeyManager] Native stderr", { key, message });
      }
    });

    child.on("error", (error) => {
      if (this.listeners.get(key) === entry) this._stopKey(key);
      this.reportError(error);
    });

    child.on("exit", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine) this.handleOutputLine(trailingLine, key);

      // wasTracked is false for intentional stops (_stopKey deletes first), so this
      // reports only unexpected exits — including signal crashes, where code is null.
      const wasTracked = this.listeners.get(key) === entry;
      if (wasTracked) this._stopKey(key);
      if (wasTracked && (code || signal)) {
        this.reportError(
          new Error(
            `Linux key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          )
        );
      }
    });
  }

  _stopKey(key) {
    const entry = this.listeners.get(key);
    if (!entry) return;
    this.listeners.delete(key);
    if (entry.watchdog) clearTimeout(entry.watchdog);
    debugLogger.debug("[LinuxKeyManager] Stopping key listener", { key });
    try {
      entry.child.kill();
    } catch {
      // Already gone
    }
  }

  handleOutputLine(line, key) {
    if (line === "READY") {
      debugLogger.debug("[LinuxKeyManager] Listener ready", { key });
      this.emit("ready", key);
      return;
    }

    if (line === "NO_PERMISSION") {
      debugLogger.warn("[LinuxKeyManager] No permission to access input devices");
      this.emit("permission-denied");
      return;
    }

    if (line === "KEY_DOWN") {
      debugLogger.debug("[LinuxKeyManager] KEY_DOWN detected", { key });
      const entry = this.listeners.get(key);
      if (entry) {
        if (entry.watchdog) clearTimeout(entry.watchdog);
        entry.watchdog = setTimeout(() => {
          debugLogger.warn("[LinuxKeyManager] Watchdog: no KEY_UP within 30s, forcing release", {
            key,
          });
          entry.watchdog = null;
          this.emit("key-up", key);
        }, WATCHDOG_MS);
      }
      this.emit("key-down", key);
      return;
    }

    if (line === "KEY_UP") {
      debugLogger.debug("[LinuxKeyManager] KEY_UP detected", { key });
      const entry = this.listeners.get(key);
      if (entry?.watchdog) {
        clearTimeout(entry.watchdog);
        entry.watchdog = null;
      }
      this.emit("key-up", key);
      return;
    }

    debugLogger.debug("[LinuxKeyManager] Unknown output", { key, line });
  }

  stop() {
    for (const key of [...this.listeners.keys()]) this._stopKey(key);
  }

  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  reportError(error) {
    if (this.hasReportedError) return;
    this.hasReportedError = true;
    debugLogger.warn("[LinuxKeyManager] Error occurred", { error: error.message });
    this.emit("error", error);
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
