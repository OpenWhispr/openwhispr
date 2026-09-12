const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HIDDEN_LAUNCH_FLAG,
  getLoginItemArgs,
  getLoginItemLookupPath,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
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

// Electron parses the lookup path AND every Run value with CommandLine::FromString,
// then compares the parsed programs. Unquoted, "C:\Program Files\OpenWhispr\..."
// truncates to "C:\Program" and compares equal to any other unquoted Run entry under
// C:\Program Files, so executableWillLaunchAtLogin reports a stranger's startup entry
// as ours — and keeps reporting true once ours is gone, which is what makes the
// launch-at-login switch impossible to turn off.
test("Windows passes a quoted lookup path so the exe comparison is exact", () => {
  assert.equal(
    getLoginItemLookupPath("win32", "C:\\Program Files\\OpenWhispr\\OpenWhispr.exe"),
    '"C:\\Program Files\\OpenWhispr\\OpenWhispr.exe"'
  );
});

// FormatCommandLineString strips one layer of surrounding quotes before re-quoting,
// but double-quoting would still be wrong to write, so never wrap twice.
test("an already quoted Windows path is not quoted twice", () => {
  assert.equal(
    getLoginItemLookupPath("win32", '"C:\\Program Files\\OpenWhispr\\OpenWhispr.exe"'),
    '"C:\\Program Files\\OpenWhispr\\OpenWhispr.exe"'
  );
});

// Only Windows parses the path this way, and passing one elsewhere would change what
// macOS compares against.
test("platforms other than Windows pass no lookup path", () => {
  assert.equal(getLoginItemLookupPath("darwin", "/Applications/OpenWhispr.app"), null);
  assert.equal(getLoginItemLookupPath("linux", "/usr/bin/open-whispr"), null);
});

// Falling back to no path is what the caller already did, and is still correct.
test("a missing executable path yields no lookup path", () => {
  assert.equal(getLoginItemLookupPath("win32", ""), null);
  assert.equal(getLoginItemLookupPath("win32", undefined), null);
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
