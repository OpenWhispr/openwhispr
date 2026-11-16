const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// debugLogger writes a file only at --log-level=debug, so a GPU pack that
// can't be used would leave no trace of why transcription fell back (#2554).
// These warnings also go to a log of their own at any level. The first one of
// each launch replaces the previous launch's lines, so the file never grows.
const LOG_FILENAME = "gpu-fallback.log";

let startedThisLaunch = false;

function getLogPath() {
  return path.join(app.getPath("userData"), "logs", LOG_FILENAME);
}

function warnGpuFallback(message, meta) {
  debugLogger.warn(message, meta);
  try {
    const logPath = getLogPath();
    const line = `[${new Date().toISOString()}] [${app.getVersion()}] ${message} ${JSON.stringify(meta)}\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (startedThisLaunch) fs.appendFileSync(logPath, line);
    else fs.writeFileSync(logPath, line);
    startedThisLaunch = true;
  } catch {
    // Best-effort: the warning still went to debugLogger.
  }
}

module.exports = { warnGpuFallback };
