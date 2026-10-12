const { execFile } = require("child_process");
const { resolveBundledBinary } = require("./binaryResolver");

// The guide polls this while the overlay is open, so a hung helper must never
// hold it up: the query is cheap enough that a short timeout is plenty.
const TIMEOUT_MS = 400;

// Resolved once: the resolver logs every lookup, and the guide polls twice a
// second for as long as the overlay is open.
let binaryPath;
function helperBinary() {
  if (binaryPath === undefined) {
    binaryPath =
      process.platform === "darwin"
        ? resolveBundledBinary("macos-window-bounds", "permission-guide")
        : null;
  }
  return binaryPath;
}

function isSettingsWindowStateAvailable() {
  return helperBinary() !== null;
}

// { settings: bounds | null, authPrompt, frontmost, settingsRunning }, or null
// when the state could not be read at all. null means unknown, never "closed":
// dismissing the overlay on a transient read failure would strand the user
// mid-permission. settingsRunning tells a dialog on another Space (no window
// on screen, app still running) from one that was closed.
function readSettingsWindowState() {
  const binary = helperBinary();
  if (!binary) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(binary, [String(process.pid)], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null);

      try {
        resolve(JSON.parse(String(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}

module.exports = { readSettingsWindowState, isSettingsWindowStateAvailable };
