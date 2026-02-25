const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

// Mach-O CPU type constants for architecture verification
const ARCH_CPU_TYPE = {
  arm64: 0x0100000c, // CPU_TYPE_ARM64
  x64: 0x01000007, // CPU_TYPE_X86_64
};

// Maximum number of rapid automatic restarts before giving up
const MAX_RESTART_ATTEMPTS = 3;
// Delay between restart attempts (ms)
const RESTART_DELAY_MS = 1000;
// After this much sustained uptime, reset restart counter (allows future restarts after sleep/wake)
const RESTART_RESET_MS = 10000;

class GlobeKeyManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === "darwin";
    this.hasReportedError = false;
    this._isStopping = false;
    this._restartCount = 0;
    this._restartResetTimer = null;
  }

  start() {
    if (!this.isSupported) {
      debugLogger.info("[GlobeKeyManager] Skipped — not macOS");
      return;
    }
    if (this.process) {
      debugLogger.info("[GlobeKeyManager] Skipped — already running");
      return;
    }

    this._isStopping = false;

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      debugLogger.info("[GlobeKeyManager] Binary not found in any candidate path");
      this.reportError(
        new Error(
          "macOS Globe listener binary not found. Run `npm run compile:globe` before packaging."
        )
      );
      return;
    }

    debugLogger.info("[GlobeKeyManager] Binary found", { path: listenerPath });

    // Verify binary architecture matches the running process
    const archMismatch = this._checkArchMismatch(listenerPath);
    if (archMismatch) {
      this.reportError(new Error(archMismatch));
      return;
    }

    try {
      fs.accessSync(listenerPath, fs.constants.X_OK);
    } catch {
      debugLogger.info("[GlobeKeyManager] Binary not executable, attempting chmod");
      try {
        fs.chmodSync(listenerPath, 0o755);
      } catch {
        this.reportError(
          new Error(`macOS Globe listener is not executable and chmod failed: ${listenerPath}`)
        );
        return;
      }
    }

    this.hasReportedError = false;
    this.process = spawn(listenerPath);
    debugLogger.info("[GlobeKeyManager] Process spawned", { pid: this.process.pid });

    // After sustained uptime, reset the restart counter so future sleep/wake
    // cycles get a fresh set of restart attempts
    if (this._restartResetTimer) clearTimeout(this._restartResetTimer);
    this._restartResetTimer = setTimeout(() => {
      this._restartResetTimer = null;
      if (this._restartCount > 0) {
        debugLogger.info("[GlobeKeyManager] Sustained uptime — restart counter reset");
        this._restartCount = 0;
      }
    }, RESTART_RESET_MS);

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          if (line === "FN_DOWN") {
            this.emit("globe-down");
          } else if (line === "FN_UP") {
            this.emit("globe-up");
          } else if (line.startsWith("RIGHT_MOD_DOWN:")) {
            const modifier = line.replace("RIGHT_MOD_DOWN:", "").trim();
            if (modifier) {
              this.emit("right-modifier-down", modifier);
            }
          } else if (line.startsWith("RIGHT_MOD_UP:")) {
            const modifier = line.replace("RIGHT_MOD_UP:", "").trim();
            if (modifier) {
              this.emit("right-modifier-up", modifier);
            }
          } else if (line.startsWith("MODIFIER_UP:")) {
            const modifier = line.replace("MODIFIER_UP:", "").trim().toLowerCase();
            if (modifier) {
              this.emit("modifier-up", modifier);
            }
          }
        });
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        if (message.includes("Failed to create event tap")) {
          this.reportError(new Error(message));
        } else {
          debugLogger.warn("[GlobeKeyManager] Non-fatal stderr output", { message });
        }
      }
    });

    this.process.on("error", (error) => {
      debugLogger.info("[GlobeKeyManager] Process error", { error: error.message });
      this.reportError(error);
      this.process = null;
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.info("[GlobeKeyManager] Process exited", { code, signal });
      this.process = null;
      if (this._restartResetTimer) {
        clearTimeout(this._restartResetTimer);
        this._restartResetTimer = null;
      }

      // Intentional stop — don't restart or report
      if (this._isStopping || signal === "SIGINT" || signal === "SIGTERM") {
        return;
      }

      if (code !== 0) {
        const error = new Error(
          `Globe key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
        );
        this.reportError(error);
        return;
      }

      // Exit code 0 but we didn't request stop — the event tap was likely
      // invalidated (e.g. after sleep/wake). Attempt automatic restart.
      if (this._restartCount < MAX_RESTART_ATTEMPTS) {
        this._restartCount++;
        debugLogger.warn(
          `[GlobeKeyManager] Unexpected exit (code 0), restarting (attempt ${this._restartCount}/${MAX_RESTART_ATTEMPTS})`
        );
        setTimeout(() => {
          if (!this._isStopping && !this.process) {
            this.start();
          }
        }, RESTART_DELAY_MS);
      } else {
        debugLogger.error(
          "GlobeKeyManager exhausted restart attempts",
          { attempts: MAX_RESTART_ATTEMPTS },
          "hotkey"
        );
        this.reportError(
          new Error(
            `Globe key listener keeps exiting unexpectedly (${MAX_RESTART_ATTEMPTS} restarts failed). ` +
              "Try restarting OpenWhispr."
          )
        );
      }
    });
  }

  stop() {
    this._isStopping = true;
    if (this._restartResetTimer) {
      clearTimeout(this._restartResetTimer);
      this._restartResetTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  reportError(error) {
    if (this.hasReportedError) {
      return;
    }
    this.hasReportedError = true;
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      } finally {
        this.process = null;
      }
    }
    debugLogger.error("GlobeKeyManager error", { error: error.message }, "hotkey");
    this.emit("error", error);
  }

  _checkArchMismatch(binaryPath) {
    try {
      const fd = fs.openSync(binaryPath, "r");
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      const magic = header.readUInt32LE(0);
      if (magic !== 0xfeedfacf) {
        return `Globe listener binary is not a valid 64-bit Mach-O file (magic: 0x${magic.toString(16)})`;
      }

      const cpuType = header.readInt32LE(4);
      const expectedCpu = ARCH_CPU_TYPE[process.arch];
      if (expectedCpu && cpuType !== expectedCpu) {
        const archNames = { [ARCH_CPU_TYPE.arm64]: "arm64", [ARCH_CPU_TYPE.x64]: "x86_64" };
        const binaryArch = archNames[cpuType] || `unknown(0x${cpuType.toString(16)})`;
        return (
          `Globe listener binary architecture mismatch: binary is ${binaryArch} ` +
          `but this Mac requires ${process.arch}. The app may have been built incorrectly. ` +
          `Try reinstalling or run \`TARGET_ARCH=${process.arch} npm run compile:globe\`.`
        );
      }

      debugLogger.info("[GlobeKeyManager] Binary architecture verified", {
        arch: process.arch,
        cpuType: `0x${cpuType.toString(16)}`,
      });
      return null;
    } catch (err) {
      debugLogger.warn("[GlobeKeyManager] Could not verify binary architecture", {
        error: err.message,
      });
      // Don't block startup on verification failure — let spawn attempt proceed
      return null;
    }
  }

  resolveListenerBinary() {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", "macos-globe-listener"),
      path.join(__dirname, "..", "..", "resources", "macos-globe-listener"),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, "macos-globe-listener"),
        path.join(process.resourcesPath, "bin", "macos-globe-listener"),
        path.join(process.resourcesPath, "resources", "macos-globe-listener"),
        path.join(process.resourcesPath, "resources", "bin", "macos-globe-listener"),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "macos-globe-listener"),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "resources",
          "bin",
          "macos-globe-listener"
        ),
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

module.exports = GlobeKeyManager;
