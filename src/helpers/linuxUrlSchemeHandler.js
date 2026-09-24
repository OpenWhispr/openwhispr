const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { resolveExecutablePath } = require("./linuxAutostart");

const XDG_TOOL_TIMEOUT_MS = 3000;
const PACKAGED_DESKTOP_FILE = "open-whispr.desktop";

// Characters the Desktop Entry spec says must be quoted in an Exec argument.
const EXEC_RESERVED_CHARACTERS = /[\s"'\\><~|&;$*?#()`]/;

// NoDisplay keeps it out of app menus, where a deb/rpm or the AppImage's own
// entry already appears; it exists only to receive the sign-in callback.
function buildHandlerEntry(protocol, launchCommand) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=OpenWhispr",
    `Exec=${[...launchCommand.map((arg) => arg.replace(/%/g, "%%")), "%U"].join(" ")}`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=x-scheme-handler/${protocol};`,
    "",
  ].join("\n");
}

function runXdgTool(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: XDG_TOOL_TIMEOUT_MS }).trim();
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// update-desktop-database only refreshes the "can open" cache that some desktops
// read; the default set below does not depend on it, so it is optional.
function refreshDesktopDatabase(applicationsDir) {
  try {
    runXdgTool("update-desktop-database", [applicationsDir]);
  } catch {
    // Not installed; nothing to refresh.
  }
}

// A deb/rpm entry declares the scheme itself, but an AppImage or tar.gz run on
// the same machine may have made its own entry the default. Point it back here
// with xdg-mime: in xdg-utils' generic mode, xdg-settings reverts to the previous
// default when the app is not also the text/html browser.
function reclaimFromOwnHandler(fileName, mimeType) {
  try {
    if (runXdgTool("xdg-mime", ["query", "default", mimeType]) === fileName) {
      runXdgTool("xdg-mime", ["default", PACKAGED_DESKTOP_FILE, mimeType]);
    }
  } catch {
    // xdg-mime unavailable; registerOpenWhisprProtocol reports the outcome.
  }
}

// Only AppImage and unpacked runs (tar.gz, development) lack a desktop entry for
// the scheme, so only they write one. Flatpak and Nix install their own entry
// from a sandbox or read-only store. Named after the scheme, not
// open-whispr.desktop: a user entry with the packaged name would shadow a
// deb/rpm install's entry, and staging/dev keep their own.
function registerLinuxUrlSchemeHandler(protocol, appArgs = []) {
  const fileName = `${protocol}-url-handler.desktop`;
  const mimeType = `x-scheme-handler/${protocol}`;
  if (process.env.FLATPAK_ID || process.execPath.startsWith("/nix/store/")) {
    return { registered: false };
  }
  // electron-builder writes this marker into deb/rpm builds only, after the
  // AppImage and tar.gz are packed; electron-updater reads it the same way.
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "package-type"))) {
    reclaimFromOwnHandler(fileName, mimeType);
    return { registered: false };
  }

  const launchCommand = [resolveExecutablePath(), ...appArgs];
  // Generic-mode xdg-open takes the first space-separated word of Exec as the
  // program, quotes included, so a quoted Exec would register but never launch.
  if (launchCommand.some((arg) => EXEC_RESERVED_CHARACTERS.test(arg))) {
    return { registered: false, reason: `launch path needs quoting: ${launchCommand[0]}` };
  }

  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const applicationsDir = path.join(dataHome, "applications");
    const filePath = path.join(applicationsDir, fileName);
    // Rewriting on any change also re-points the entry after the AppImage moves.
    const contents = buildHandlerEntry(protocol, launchCommand);
    if (readFileOrNull(filePath) !== contents) {
      fs.mkdirSync(applicationsDir, { recursive: true });
      fs.writeFileSync(filePath, contents, { mode: 0o644 });
      refreshDesktopDatabase(applicationsDir);
    }

    if (runXdgTool("xdg-mime", ["query", "default", mimeType]) === fileName) {
      return { registered: true };
    }
    runXdgTool("xdg-mime", ["default", fileName, mimeType]);
    const handler = runXdgTool("xdg-mime", ["query", "default", mimeType]);
    if (handler === fileName) return { registered: true };
    return { registered: false, reason: `default stayed ${handler || "unset"}` };
  } catch (error) {
    return { registered: false, reason: error.message };
  }
}

module.exports = { buildHandlerEntry, registerLinuxUrlSchemeHandler };
