const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");
const { quoteExecPath, resolveExecutablePath } = require("./linuxAutostart");

const XDG_TOOL_TIMEOUT_MS = 3000;

// Characters the Desktop Entry spec says must be quoted in an Exec argument.
const EXEC_RESERVED_CHARACTERS = /[\s"'\\><~|&;$*?#()`]/;

// Only AppImage and unpacked runs (tar.gz, development) lack a desktop entry for
// the scheme. deb/rpm ship one with MimeType=x-scheme-handler/…, and Flatpak,
// Snap and Nix install their own entry from a sandbox or read-only store.
function getLinuxInstallType() {
  if (process.env.FLATPAK_ID) return "flatpak";
  if (process.env.SNAP) return "snap";
  if (process.execPath.startsWith("/nix/store/")) return "nix";
  if (process.env.APPIMAGE) return "appimage";
  // electron-builder writes this marker into deb/rpm builds only, after the
  // AppImage and tar.gz are packed; electron-updater reads it the same way.
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "package-type"))) {
    return "package";
  }
  return "unpacked";
}

// Quotes only when the spec requires it: xdg-mime default reads the program as
// the first space-separated word of Exec, quotes included, and newer releases
// refuse an entry whose program is not executable (xdg-utils #253).
function formatExecArg(arg) {
  const escaped = arg.replace(/%/g, "%%");
  return EXEC_RESERVED_CHARACTERS.test(escaped) ? quoteExecPath(escaped) : escaped;
}

// NoDisplay keeps it out of app menus, where a deb/rpm or the AppImage's own
// entry already appears; it exists only to receive the sign-in callback.
function buildHandlerEntry(protocol, launchCommand) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=OpenWhispr",
    `Exec=${[...launchCommand.map(formatExecArg), "%U"].join(" ")}`,
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
  } catch (error) {
    debugLogger.debug("update-desktop-database unavailable", { error: error.message });
  }
}

// Named after the scheme, not open-whispr.desktop: a user entry with the packaged
// name would shadow a deb/rpm install's entry, and staging/dev keep their own.
function registerLinuxUrlSchemeHandler(protocol, appArgs = []) {
  const installType = getLinuxInstallType();
  if (installType !== "appimage" && installType !== "unpacked") return false;

  const fileName = `${protocol}-url-handler.desktop`;
  const mimeType = `x-scheme-handler/${protocol}`;
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const applicationsDir = path.join(dataHome, "applications");
    const filePath = path.join(applicationsDir, fileName);
    // Rewriting on any change also re-points the entry after the AppImage moves.
    const contents = buildHandlerEntry(protocol, [resolveExecutablePath(), ...appArgs]);
    if (readFileOrNull(filePath) !== contents) {
      fs.mkdirSync(applicationsDir, { recursive: true });
      fs.writeFileSync(filePath, contents, { mode: 0o644 });
      refreshDesktopDatabase(applicationsDir);
    }

    if (runXdgTool("xdg-mime", ["query", "default", mimeType]) === fileName) return true;
    runXdgTool("xdg-mime", ["default", fileName, mimeType]);
    const handler = runXdgTool("xdg-mime", ["query", "default", mimeType]);
    if (handler === fileName) return true;

    debugLogger.warn("URL scheme handler did not become the default", {
      protocol,
      installType,
      handler,
    });
    return false;
  } catch (error) {
    debugLogger.warn("Could not register URL scheme handler", {
      protocol,
      installType,
      error: error.message,
    });
    return false;
  }
}

module.exports = { buildHandlerEntry, getLinuxInstallType, registerLinuxUrlSchemeHandler };
