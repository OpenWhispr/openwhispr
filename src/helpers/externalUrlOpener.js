const { shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const debugLogger = require("./debugLogger");

// On Windows, shell.openExternal runs ShellExecuteExW inside the Electron main
// process, so a cold-started default browser (and any meeting client it
// protocol-launches) becomes a descendant of our PID. The system-audio helper
// captures with PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE rooted at
// that PID (windowsLoopbackAudioManager.js --exclude-pid), which would silence
// the meeting's audio. Handing http/https URLs to explorer.exe forwards the
// open to the long-running desktop shell via COM, so the browser is created
// outside our process tree. The protocol gate is load-bearing: explorer.exe
// EXECUTES non-URL arguments such as file paths. The absolute path is too:
// a bare "explorer.exe" resolves from the CWD first (binary planting).
async function openExternalUrl(url) {
  const { protocol, href } = new URL(url);
  if (process.platform === "win32" && (protocol === "http:" || protocol === "https:")) {
    const explorerPath = path.win32.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(explorerPath, [href], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("spawn", resolve);
        child.unref();
      });
      return;
    } catch (error) {
      // No spawnable shell (relocated SystemRoot, LTSC/Server images, execution
      // policy). Degraded system-audio capture beats a link that never opens,
      // so fall through to the direct open rather than failing the click.
      debugLogger.warn(
        "explorer.exe launch failed, opening URL in-process",
        { error: error.message },
        "window"
      );
    }
  }
  return shell.openExternal(url);
}

module.exports = { openExternalUrl };
