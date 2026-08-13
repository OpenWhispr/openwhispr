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
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
};
