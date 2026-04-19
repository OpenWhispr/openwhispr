const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class LinuxKeyManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === "linux";
    this.hasReportedError = false;
    this.currentKey = null;
    this.isReady = false;
    this.watchdogTimer = null;
  }

  handleOutputLine(line, key) {
    if (line === "READY") {
      debugLogger.debug("[LinuxKeyManager] Listener ready", { key });
      this.isReady = true;
      this.emit("ready");
      return;
    }

    if (line === "NO_PERMISSION") {
      debugLogger.warn("[LinuxKeyManager] No permission to access input devices");
      this.emit("permission-denied");
      return;
    }

    if (line === "KEY_DOWN") {
      debugLogger.debug("[LinuxKeyManager] KEY_DOWN detected", { key });
      if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
      this.watchdogTimer = setTimeout(() => {
        debugLogger.warn("[LinuxKeyManager] Watchdog: no KEY_UP within 30s, forcing release");
        this.emit("key-up", this.currentKey);
        this.watchdogTimer = null;
      }, 30000);
      this.emit("key-down", key);
      return;
    }

    if (line === "KEY_UP") {
      debugLogger.debug("[LinuxKeyManager] KEY_UP detected", { key });
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
      this.emit("key-up", key);
      return;
    }

    debugLogger.debug("[LinuxKeyManager] Unknown output", { line });
  }

  start(key = "`") {
    if (!this.isSupported) return;
    if (this.process && this.currentKey === key) return;

    this.stop();

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      this.emit("unavailable", new Error("Linux key listener binary not found"));
      return;
    }

    this.hasReportedError = false;
    this.isReady = false;
    this.currentKey = key;

    debugLogger.debug("[LinuxKeyManager] Starting key listener", {
      key,
      binaryPath: listenerPath,
    });

    try {
      this.process = spawn(listenerPath, [key], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      debugLogger.error("[LinuxKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error);
      return;
    }

    let lineBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleOutputLine(line, key);
      }
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        debugLogger.debug("[LinuxKeyManager] Native stderr", { message });
      }
    });

    const proc = this.process;

    proc.on("error", (error) => {
      if (this.process === proc) this.process = null;
      this.reportError(error);
    });

    proc.on("exit", (code, signal) => {
      const trailingLine = lineBuffer.trim();
      if (trailingLine) {
        this.handleOutputLine(trailingLine, key);
        lineBuffer = "";
      }

      if (this.process === proc) {
        this.process = null;
        this.isReady = false;
      }
      if (code !== 0) {
        this.reportError(
          new Error(
            `Linux key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
          )
        );
      }
    });
  }

  stop() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.process) {
      debugLogger.debug("[LinuxKeyManager] Stopping key listener");
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
    this.isReady = false;
    this.currentKey = null;
  }

  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  reportError(error) {
    if (this.hasReportedError) return;
    this.hasReportedError = true;

    if (this.process) {
      try {
        this.process.kill();
      } catch {
      } finally {
        this.process = null;
      }
    }

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
