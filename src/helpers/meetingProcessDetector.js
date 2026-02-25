const { execSync } = require("child_process");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");

const POLL_INTERVAL_MS = 20 * 1000;
const EXEC_OPTS = { timeout: 3000, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] };

const MEETING_APPS = {
  darwin: [
    { processKey: "zoom", appName: "Zoom", check: () => hasProcessExact("CptHost") },
    {
      processKey: "teams",
      appName: "Microsoft Teams",
      check: () => hasProcess("MSTeams") && hasActiveAudio("MSTeams"),
    },
    {
      processKey: "facetime",
      appName: "FaceTime",
      check: () => hasProcessExact("FaceTime") && hasActiveAudio("FaceTime"),
    },
    { processKey: "webex", appName: "Webex", check: () => hasProcess("webexmeetingsapp") },
  ],
  win32: [
    {
      processKey: "zoom",
      appName: "Zoom",
      check: () => {
        const out = execSync('tasklist /FI "IMAGENAME eq CptHost.exe" /NH', EXEC_OPTS);
        return out.includes("CptHost");
      },
    },
    {
      processKey: "teams",
      appName: "Microsoft Teams",
      check: () => {
        const out = execSync(
          "powershell -NoProfile -Command \"(Get-Process -Name 'ms-teams_modulehost' -ErrorAction SilentlyContinue).Count -gt 0\"",
          EXEC_OPTS
        );
        return out.trim() === "True";
      },
    },
    {
      processKey: "webex",
      appName: "Webex",
      check: () => {
        const out = execSync('tasklist /FI "IMAGENAME eq webexmeetingsapp.exe" /NH', EXEC_OPTS);
        return out.includes("webexmeetingsapp");
      },
    },
  ],
  linux: [
    { processKey: "zoom", appName: "Zoom", check: () => hasProcess("zoom") },
    { processKey: "teams", appName: "Microsoft Teams", check: () => hasProcess("teams") },
  ],
};

function hasProcess(name) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist | findstr /I "${name}"`, EXEC_OPTS);
      return out.trim().length > 0;
    }
    execSync(`pgrep -f "${name}"`, EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

function hasProcessExact(name) {
  try {
    execSync(`pgrep -x "${name}"`, EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

function hasActiveAudio(appName) {
  if (process.platform !== "darwin") return true;
  try {
    const out = execSync(`lsof -c "${appName}" 2>/dev/null | grep -i coreaudio`, EXEC_OPTS);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

class MeetingProcessDetector extends EventEmitter {
  constructor() {
    super();
    this.pollInterval = null;
    this.detectedProcesses = new Map();
    this.dismissedProcesses = new Set();
  }

  start() {
    if (this.pollInterval) return;
    const apps = MEETING_APPS[process.platform] || [];
    debugLogger.info(
      "Process detector started",
      {
        platform: process.platform,
        appsMonitored: apps.map((a) => a.appName),
        intervalMs: POLL_INTERVAL_MS,
      },
      "meeting"
    );
    this._poll();
    this.pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.detectedProcesses.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey) {
    this.dismissedProcesses.add(processKey);
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  getDetectedProcesses() {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: this._getAppName(processKey),
      detectedAt,
    }));
  }

  _getAppName(processKey) {
    const apps = MEETING_APPS[process.platform] || [];
    const entry = apps.find((a) => a.processKey === processKey);
    return entry ? entry.appName : processKey;
  }

  _poll() {
    try {
      const apps = MEETING_APPS[process.platform] || [];

      for (const { processKey, appName, check } of apps) {
        let isRunning = false;
        try {
          isRunning = check();
        } catch {
          isRunning = false;
        }

        if (isRunning) {
          if (!this.detectedProcesses.has(processKey) && !this.dismissedProcesses.has(processKey)) {
            const detectedAt = Date.now();
            this.detectedProcesses.set(processKey, { detectedAt });
            debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
            this.emit("meeting-process-detected", { processKey, appName, detectedAt });
          }
        } else if (this.detectedProcesses.has(processKey)) {
          this.detectedProcesses.delete(processKey);
          debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
          this.emit("meeting-process-ended", { processKey, appName });
        }
      }
    } catch (err) {
      debugLogger.warn("Poll error", { error: err.message }, "meeting");
    }
  }
}

module.exports = MeetingProcessDetector;
