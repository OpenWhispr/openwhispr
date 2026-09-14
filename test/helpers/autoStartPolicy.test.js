const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HIDDEN_LAUNCH_FLAG,
  getLoginItemArgs,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
  getRelaunchOptions,
  getRelaunchWaiter,
} = require("../../src/helpers/autoStartPolicy.js");

// getLoginItemSettings compares the Run value against `"exe" args` verbatim, so
// reads that pass different args than writes did always report openAtLogin false.
test("Windows login items are read and written with the same args", () => {
  assert.deepEqual(getLoginItemArgs("win32"), [HIDDEN_LAUNCH_FLAG]);
});

test("platforms without a hidden-launch flag pass no args", () => {
  assert.deepEqual(getLoginItemArgs("darwin"), []);
  assert.deepEqual(getLoginItemArgs("linux"), []);
});

// The bug behind the reported "startup app not recognized": openAtLogin only
// checks the Run entry, so an app the user switched off in Task Manager still
// reads as enabled while never actually starting.
test("a startup item disabled in Task Manager reads as disabled on Windows", () => {
  const state = resolveAutoStartState({
    platform: "win32",
    loginItemSettings: { openAtLogin: true, executableWillLaunchAtLogin: false },
  });
  assert.equal(state.enabled, false);
});

test("a startup item Windows will actually launch reads as enabled", () => {
  const state = resolveAutoStartState({
    platform: "win32",
    loginItemSettings: { openAtLogin: true, executableWillLaunchAtLogin: true },
  });
  assert.deepEqual(state, { enabled: true, requiresApproval: false });
});

// An entry written by an older build carries no --hidden, so it no longer matches
// what we write now even though it is still there and still launching the app.
test("Windows re-enables through executableWillLaunchAtLogin when only the args differ", () => {
  const state = resolveAutoStartState({
    platform: "win32",
    loginItemSettings: { openAtLogin: false, executableWillLaunchAtLogin: true },
  });
  assert.equal(state.enabled, true);
});

// Electron derives openAtLogin on macOS 13+ from `status == "enabled"`, so an item
// awaiting approval necessarily reads as off. Surfacing the reason is what turns
// that from a toggle that silently will not stick into something explainable.
test("an item awaiting approval reads as off, with the reason surfaced", () => {
  const state = resolveAutoStartState({
    platform: "darwin",
    loginItemSettings: { openAtLogin: false, status: "requires-approval" },
  });
  assert.deepEqual(state, { enabled: false, requiresApproval: true });
});

test("macOS reports an approved item without prompting for approval", () => {
  const state = resolveAutoStartState({
    platform: "darwin",
    loginItemSettings: { openAtLogin: true, status: "enabled" },
  });
  assert.deepEqual(state, { enabled: true, requiresApproval: false });
});

test("a disabled macOS item is neither enabled nor awaiting approval", () => {
  const state = resolveAutoStartState({
    platform: "darwin",
    loginItemSettings: { openAtLogin: false, status: "not-registered" },
  });
  assert.deepEqual(state, { enabled: false, requiresApproval: false });
});

test("an entry written before the hidden flag is migrated", () => {
  assert.equal(
    needsHiddenFlagMigration({
      platform: "win32",
      loginItemSettings: { openAtLogin: false, executableWillLaunchAtLogin: true },
    }),
    true
  );
});

test("an entry already carrying the hidden flag is left alone", () => {
  assert.equal(
    needsHiddenFlagMigration({
      platform: "win32",
      loginItemSettings: { openAtLogin: true, executableWillLaunchAtLogin: true },
    }),
    false
  );
});

// Migrating here would recreate an entry the user deliberately removed.
test("launch at login that is simply off is not mistaken for a stale entry", () => {
  assert.equal(
    needsHiddenFlagMigration({
      platform: "win32",
      loginItemSettings: { openAtLogin: false, executableWillLaunchAtLogin: false },
    }),
    false
  );
});

test("migration is Windows-only", () => {
  assert.equal(
    needsHiddenFlagMigration({
      platform: "darwin",
      loginItemSettings: { openAtLogin: false, executableWillLaunchAtLogin: true },
    }),
    false
  );
});

test("Windows and Linux detect a login launch from the flag on argv", () => {
  for (const platform of ["win32", "linux"]) {
    assert.equal(
      wasLaunchedHidden({ platform, argv: ["OpenWhispr.exe", HIDDEN_LAUNCH_FLAG] }),
      true,
      platform
    );
    assert.equal(wasLaunchedHidden({ platform, argv: ["OpenWhispr.exe"] }), false, platform);
  }
});

// openAsHidden and wasOpenedAsHidden are no-ops on macOS 13+, so wasOpenedAtLogin
// is the only signal left that the session, not the user, started us.
test("macOS detects a login launch from wasOpenedAtLogin, not from argv", () => {
  assert.equal(
    wasLaunchedHidden({
      platform: "darwin",
      argv: ["OpenWhispr"],
      loginItemSettings: { wasOpenedAtLogin: true },
    }),
    true
  );
  assert.equal(
    wasLaunchedHidden({
      platform: "darwin",
      argv: ["OpenWhispr", HIDDEN_LAUNCH_FLAG],
      loginItemSettings: { wasOpenedAtLogin: false },
    }),
    false
  );
});

test("a relaunch drops the hidden-launch flag and keeps every other arg", () => {
  assert.deepEqual(
    getRelaunchOptions({
      argv: ["OpenWhispr.exe", HIDDEN_LAUNCH_FLAG, "--log-level=debug"],
      protocol: "openwhispr",
    }),
    { args: ["--log-level=debug"] }
  );
});

test("a relaunch drops the deep link that cold-started the app", () => {
  assert.deepEqual(
    getRelaunchOptions({
      argv: [
        "OpenWhispr.exe",
        "openwhispr://auth/callback?bearer_token=stale",
        "--proxy-server=http://proxy:8080",
      ],
      protocol: "openwhispr",
    }),
    { args: ["--proxy-server=http://proxy:8080"] }
  );
});

test("an AppImage relaunches from the AppImage file, not its FUSE mount", () => {
  assert.deepEqual(
    getRelaunchOptions({
      argv: ["/tmp/.mount_OpenWh/open-whispr", "--no-sandbox"],
      protocol: "openwhispr",
      appImagePath: "/home/user/OpenWhispr.AppImage",
    }),
    { launcherPath: "/home/user/OpenWhispr.AppImage", args: ["--no-sandbox"] }
  );
});

test("the Windows portable build relaunches from the portable exe, not its unpack dir", () => {
  assert.deepEqual(
    getRelaunchOptions({
      argv: ["C:\\Users\\me\\AppData\\Local\\Temp\\2abc\\OpenWhispr.exe", HIDDEN_LAUNCH_FLAG],
      protocol: "openwhispr",
      portableExecutablePath: "D:\\Tools\\OpenWhispr-1.10.0.exe",
    }),
    { launcherPath: "D:\\Tools\\OpenWhispr-1.10.0.exe", args: [] }
  );
});

test("the AppImage waiter outlives this process, then execs the file with its args", () => {
  assert.deepEqual(
    getRelaunchWaiter({
      platform: "linux",
      launcherPath: "/home/user/OpenWhispr.AppImage",
      args: ["--no-sandbox"],
      pid: 4242,
      ppid: 4200,
    }),
    {
      file: "/bin/sh",
      args: [
        "-c",
        'while kill -0 "$0"; do sleep 0.2; done; exec "$@"',
        "4242",
        "/home/user/OpenWhispr.AppImage",
        "--no-sandbox",
      ],
    }
  );
});

test("the portable waiter waits for the stub and quotes the path for PowerShell", () => {
  assert.deepEqual(
    getRelaunchWaiter({
      platform: "win32",
      launcherPath: "D:\\Tom's Tools\\OpenWhispr.exe",
      args: ["--log-level=debug"],
      pid: 4242,
      ppid: 4200,
      systemRoot: "D:\\Win",
    }),
    {
      file: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Wait-Process -Id 4200; Start-Process -FilePath 'D:\\Tom''s Tools\\OpenWhispr.exe' -ArgumentList '--log-level=debug'",
      ],
    }
  );
});

test("the portable waiter runs the system PowerShell and omits -ArgumentList without args", () => {
  assert.deepEqual(
    getRelaunchWaiter({
      platform: "win32",
      launcherPath: "D:\\Tools\\OpenWhispr.exe",
      args: [],
      pid: 4242,
      ppid: 4200,
    }),
    {
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Wait-Process -Id 4200; Start-Process -FilePath 'D:\\Tools\\OpenWhispr.exe'",
      ],
    }
  );
});
