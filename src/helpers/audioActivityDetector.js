const { execSync } = require("child_process");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");

const CHECK_INTERVAL_MS = 10 * 1000;
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
  }

  start() {
    if (this.checkInterval) return;
    debugLogger.info("Starting audio activity detector", {}, "meeting");
    this.checkInterval = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this._reset();
    debugLogger.info("Stopped audio activity detector", {}, "meeting");
  }

  dismiss() {
    this.lastDismissedAt = Date.now();
    this._reset();
  }

  _reset() {
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
  }

  _check() {
    if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;
    if (this.hasPrompted) return;

    if (this._isMicActive()) {
      this.consecutiveChecks++;
      if (!this.audioActiveStart) this.audioActiveStart = Date.now();

      if (this.consecutiveChecks >= SUSTAINED_THRESHOLD_CHECKS) {
        this.hasPrompted = true;
        const now = Date.now();
        debugLogger.info(
          "Sustained audio activity detected",
          {
            consecutiveChecks: this.consecutiveChecks,
            durationMs: now - this.audioActiveStart,
          },
          "meeting"
        );
        this.emit("sustained-audio-detected", {
          durationMs: now - this.audioActiveStart,
          detectedAt: now,
        });
      }
    } else {
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

  _checkDarwin() {
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
