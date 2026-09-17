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
// explorer.exe cannot deliver every URL: its command-line parser treats "="
// and "," as field separators, so query strings (?callbackURL=… — which broke
// every desktop OAuth sign-in, microsoft/WSL#3832), fragments (neovim#23401),
// and a bare "=" or "," in a path (rauschma/openurl#2) open a File Explorer
// window or an error dialog instead of the browser — silently, because the
// spawn itself succeeds. Those URLs go through shell.openExternal: losing the
// loopback exclusion for one open beats a link that never opens. Gate on the
// serialized href (the argv token explorer receives) — URL.search reports ""
// for a bare trailing "?". Serialization percent-encodes spaces, quotes and
// non-ASCII, so explorer always gets one ASCII token; "%" itself stays
// eligible because this shell-less spawn never expands %VAR%-style sequences.
const EXPLORER_BREAKING_CHARS = /[?#=,]/;

async function openExternalUrl(url) {
  const { protocol, href } = new URL(url);
  if (
    process.platform === "win32" &&
    (protocol === "http:" || protocol === "https:") &&
    !EXPLORER_BREAKING_CHARS.test(href)
  ) {
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
