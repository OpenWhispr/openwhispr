// Launch-at-login and relaunch decisions, kept free of Electron so they can be unit-tested.
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

// A relaunch must not replay how this process was launched: --hidden would put the
// restarted app in the tray, and startup would handle a cold-start deep link again
// (a sign-in link would restore the session a reset just cleared). An AppImage and
// the Windows portable build run from a directory that is gone once this process
// exits (the FUSE mount; the stub's %TEMP% unpack dir), so app.relaunch() cannot
// bring them back: getRelaunchWaiter() starts the on-disk file from outside instead.
function getRelaunchOptions({ argv, protocol, appImagePath, portableExecutablePath }) {
  const args = argv
    .slice(1)
    .filter((arg) => arg !== HIDDEN_LAUNCH_FLAG && !arg.startsWith(`${protocol}://`));
  const launcherPath = appImagePath || portableExecutablePath;
  return launcherPath ? { launcherPath, args } : { args };
}

// The portable stub deletes its unpack dir only after the app exits, so on Windows the
// waiter must outlive the stub (this process's parent), not just this process.
function getRelaunchWaiter({
  platform,
  launcherPath,
  args,
  pid,
  ppid,
  systemRoot = "C:\\Windows",
}) {
  if (platform === "win32") {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const argumentList = args.length ? ` -ArgumentList ${args.map(quote).join(",")}` : "";
    return {
      file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Wait-Process -Id ${ppid}; Start-Process -FilePath ${quote(launcherPath)}${argumentList}`,
      ],
    };
  }
  return {
    file: "/bin/sh",
    args: [
      "-c",
      'while kill -0 "$0"; do sleep 0.2; done; exec "$@"',
      String(pid),
      launcherPath,
      ...args,
    ],
  };
}

module.exports = {
  HIDDEN_LAUNCH_FLAG,
  getLoginItemArgs,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
  getRelaunchOptions,
  getRelaunchWaiter,
};
