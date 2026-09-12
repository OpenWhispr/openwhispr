// Launch-at-login decisions, kept free of Electron so they can be unit-tested.
//
// A login launch should come up in the tray, and Windows has no way to ask for
// that (macOS' openAsHidden is macOS-only and a no-op on macOS 13+). So the login
// item carries a flag we read back at startup. Linux puts the same flag on the
// autostart entry's Exec line; macOS reports it through wasOpenedAtLogin.

const HIDDEN_LAUNCH_FLAG = "--hidden";

// getLoginItemSettings compares the registry value against `"exe" args` verbatim,
// so reads have to pass exactly what writes did or openAtLogin is always false.
function getLoginItemArgs(platform) {
  return platform === "win32" ? [HIDDEN_LAUNCH_FLAG] : [];
}

// Windows only: the executable path to hand getLoginItemSettings, quoted.
//
// executableWillLaunchAtLogin is built by comparing parsed program paths, and BOTH
// sides go through CommandLine::FromString first (browser_win.cc,
// GetLoginItemSettingsHelper). An unquoted path containing spaces therefore truncates
// at the first space, so C:\Program Files\<app>\<app>.exe collapses to "C:\Program" —
// and so does every OTHER unquoted Run entry under C:\Program Files, of which there
// are usually several. Those then compare equal, so the field reports true because an
// unrelated app is set to launch, and keeps reporting true after our own entry is
// removed. Left unquoted it even returns true for a path that does not exist on disk.
//
// The same truncation excludes our own correctly quoted entry from launchItems, since
// it parses to the full path and no longer matches the truncated lookup.
//
// Passing no path is not a way out: getLoginItemSettings then falls back to
// GetProcessExecPath(), which is unquoted and truncates identically.
//
// Safe for openAtLogin, which uses this same path: FormatCommandLineString strips
// surrounding double quotes before re-quoting with AddQuoteForArg, so the string
// compared against the registry value is byte-for-byte the same either way.
function getLoginItemLookupPath(platform, execPath) {
  if (platform !== "win32" || !execPath) return null;
  const alreadyQuoted = execPath.length >= 2 && execPath.startsWith('"') && execPath.endsWith('"');
  return alreadyQuoted ? execPath : `"${execPath}"`;
}

// For the platforms setLoginItemSettings covers: win32 and darwin.
function resolveAutoStartState({ platform, loginItemSettings }) {
  if (platform === "win32") {
    // openAtLogin only checks whether the Run entry matches this executable and
    // args; it ignores Explorer's StartupApproved key, which is what Task Manager
    // writes when a user disables a startup app. Only this field covers both.
    return { enabled: !!loginItemSettings.executableWillLaunchAtLogin, requiresApproval: false };
  }
  return {
    enabled: !!loginItemSettings.openAtLogin,
    // macOS 13+ routes login items through SMAppService, which can register an
    // item and still leave it awaiting approval in System Settings. Unsurfaced,
    // that just looks like a toggle that will not stick.
    requiresApproval: loginItemSettings.status === "requires-approval",
  };
}

// An entry written before this build carries no flag, so it no longer matches what
// we write and reads as disabled while still launching the app with its window
// showing. Rewriting reuses the same registry value name, so it re-points that
// entry rather than adding a second one.
function needsHiddenFlagMigration({ platform, loginItemSettings }) {
  if (platform !== "win32") return false;
  return !!loginItemSettings.executableWillLaunchAtLogin && !loginItemSettings.openAtLogin;
}

// Whether the session started this process rather than the user.
function wasLaunchedHidden({ platform, argv, loginItemSettings }) {
  if (platform === "darwin") return !!loginItemSettings.wasOpenedAtLogin;
  return argv.includes(HIDDEN_LAUNCH_FLAG);
}

module.exports = {
  HIDDEN_LAUNCH_FLAG,
  getLoginItemArgs,
  getLoginItemLookupPath,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
};
