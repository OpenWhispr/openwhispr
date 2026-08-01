// Runs the native notch-probe once (and on display changes) to feed exact geometry
// into notchDisplay. Any failure is a safe no-op; the heuristic stays as fallback.

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const notchDisplay = require("./notchDisplay");

let screenApi = null;
let reprobeTimer = null;
let handlersBound = false;

function resolveBinary(binaryName) {
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
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function probe() {
  const binaryPath = resolveBinary("macos-notch-probe");
  if (!binaryPath) {
    debugLogger.warn("notch-probe binary not found, using heuristic", {}, "notch");
    return;
  }
  execFile(binaryPath, [], { timeout: 4000 }, (err, stdout) => {
    if (err) {
      debugLogger.warn("notch-probe failed", { error: err.message }, "notch");
      return;
    }
    try {
      const parsed = JSON.parse(String(stdout).trim());
      if (parsed && Array.isArray(parsed.screens)) {
        notchDisplay.setMeasuredNotchWidths(parsed.screens);
        debugLogger.info("notch-probe measured screens", { screens: parsed.screens }, "notch");
      }
    } catch (parseErr) {
      debugLogger.warn("notch-probe parse error", { error: parseErr.message }, "notch");
    }
  });
}

function scheduleReprobe() {
  if (reprobeTimer) clearTimeout(reprobeTimer);
  reprobeTimer = setTimeout(() => {
    reprobeTimer = null;
    probe();
  }, 400);
}

function init() {
  if (process.platform !== "darwin") return;
  try {
    screenApi = require("electron").screen;
  } catch {
    screenApi = null;
  }
  probe();
  if (screenApi && !handlersBound) {
    handlersBound = true;
    screenApi.on("display-added", scheduleReprobe);
    screenApi.on("display-removed", scheduleReprobe);
    screenApi.on("display-metrics-changed", scheduleReprobe);
  }
}

module.exports = { init };
