const { execFile } = require("child_process");
const { resolveBundledBinary } = require("./binaryResolver");

// Reads the System Settings window state and, on macOS 27.3 and later, the
// app's input-posting access: both come from the one bundled, signed helper.
//
// The guide polls this while the overlay is open, so a hung helper must never
// hold it up: the query is cheap enough that a short timeout is plenty.
const TIMEOUT_MS = 400;
const PERMISSION_REQUEST_TIMEOUT_MS = 5000;

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

// true or false as the helper reports it, or null when it could not answer
// (missing, timed out, failed). null means unknown, never "denied": the paste
// path asks before every paste, and one slow spawn must not cost a grant.
function queryPostEventAccess(request) {
  const binary = helperBinary();
  if (!binary) return Promise.resolve(null);

  const flag = request ? "--request-post-event-access" : "--check-post-event-access";
  const timeout = request ? PERMISSION_REQUEST_TIMEOUT_MS : TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile(binary, [flag], { timeout }, (error, stdout) => {
      // Older copies of the helper respond with window state, even for unknown flags.
      resolve(error ? null : stdout.trim() === "POST_EVENT_ALLOWED");
    });
  });
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

module.exports = { readSettingsWindowState, isSettingsWindowStateAvailable, queryPostEventAccess };
