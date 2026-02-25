const { execSync, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");

const CHECK_INTERVAL_MS = 5 * 1000;
const SUSTAINED_THRESHOLD_CHECKS = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const EXEC_OPTS = { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] };

class AudioActivityDetector extends EventEmitter {
  constructor() {
    super();
    this.checkInterval = null;
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this.lastDismissedAt = null;
    this._micCheckBinary = null;
  }

  start() {
    if (this.checkInterval) return;
    if (process.platform === "darwin") this._resolveMicCheckBinary();
    debugLogger.info(
      "Audio activity detector started",
      { intervalMs: CHECK_INTERVAL_MS, threshold: SUSTAINED_THRESHOLD_CHECKS },
      "meeting"
    );
    this._check();
    this.checkInterval = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this._reset();
    debugLogger.info("Audio activity detector stopped", {}, "meeting");
  }

  dismiss() {
    this.lastDismissedAt = Date.now();
    this._reset();
    debugLogger.info(
      "Audio detection dismissed, cooldown started",
      { cooldownMs: COOLDOWN_MS },
      "meeting"
    );
  }

  _reset() {
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
  }

  _check() {
    if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;
    if (this.hasPrompted) return;

    const active = this._isMicActive();
    debugLogger.debug(
      "Mic check",
      { active, consecutiveChecks: this.consecutiveChecks },
      "meeting"
    );

    if (active) {
      this.consecutiveChecks++;
      if (!this.audioActiveStart) this.audioActiveStart = Date.now();

      if (this.consecutiveChecks >= SUSTAINED_THRESHOLD_CHECKS) {
        this.hasPrompted = true;
        const now = Date.now();
        const durationMs = now - this.audioActiveStart;
        debugLogger.info(
          "Sustained audio activity detected",
          { consecutiveChecks: this.consecutiveChecks, durationMs },
          "meeting"
        );
        this.emit("sustained-audio-detected", { durationMs, detectedAt: now });
      }
    } else {
      if (this.consecutiveChecks > 0) {
        debugLogger.debug(
          "Mic activity reset",
          { previousChecks: this.consecutiveChecks },
          "meeting"
        );
      }
      this.consecutiveChecks = 0;
      this.audioActiveStart = null;
    }
  }

  _isMicActive() {
    switch (process.platform) {
      case "darwin":
        return this._checkDarwin();
      case "win32":
        return this._checkWin32();
      case "linux":
        return this._checkLinux();
      default:
        return false;
    }
  }

  _resolveMicCheckBinary() {
    const binaryName = "macos-mic-check";
    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName)
      );
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this._micCheckBinary = candidate;
          debugLogger.info("Resolved mic-check binary", { path: candidate }, "meeting");
          return;
        }
      } catch {
        // continue
      }
    }
    debugLogger.warn("macos-mic-check binary not found, falling back to ioreg", {}, "meeting");
  }

  _checkDarwin() {
    if (this._micCheckBinary) {
      try {
        const out = execFileSync(this._micCheckBinary, [], { timeout: 3000, encoding: "utf8" });
        return out.trim() === "true";
      } catch (err) {
        debugLogger.debug(
          "mic-check binary failed, falling back",
          { error: err.message },
          "meeting"
        );
      }
    }

    try {
      const out = execSync("ioreg -l -w 0 | grep '\"IOAudioEngineState\" = 1'", EXEC_OPTS);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  _checkWin32() {
    try {
      const out = execSync(
        "powershell -NoProfile -Command \"(Get-Process -Name 'CptHost','ms-teams_modulehost','webexmeetingsapp' -ErrorAction SilentlyContinue).Count -gt 0\"",
        EXEC_OPTS
      );
      return out.trim() === "True";
    } catch {
      return false;
    }
  }

  _checkLinux() {
    try {
      const out = execSync("pactl list source-outputs short", EXEC_OPTS);
      return out.trim().length > 0;
    } catch {
      // pactl unavailable, try PipeWire
    }

    try {
      const out = execSync("pw-cli list-objects | grep -c 'Stream/Input/Audio'", EXEC_OPTS);
      return parseInt(out.trim(), 10) > 0;
    } catch {
      return false;
    }
  }
}

module.exports = AudioActivityDetector;
