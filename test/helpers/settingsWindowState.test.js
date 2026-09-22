const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load({ platform = "darwin", binary = "/bin/macos-window-bounds", execFile } = {}) {
  const calls = [];
  const resolves = [];
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../src/helpers/settingsWindowState.js"), "utf8"),
    {
      module,
      exports: module.exports,
      process: { platform, pid: 4242 },
      require: (name) => {
        if (name === "child_process")
          return {
            execFile: (command, args, options, callback) => {
              calls.push({ command, args, options });
              execFile(callback);
            },
          };
        if (name === "./binaryResolver")
          return {
            resolveBundledBinary: () => {
              resolves.push(binary);
              return binary;
            },
          };
        return require(name);
      },
    }
  );
  return { ...module.exports, calls, resolves };
}

const succeed = (stdout) => (callback) => callback(null, stdout, "");
const report = (value) => succeed(JSON.stringify(value));

test("reads the System Settings window bounds", async () => {
  const { readSettingsWindowState } = load({
    execFile: report({ settings: { x: 232, y: 232, width: 723, height: 804 }, authPrompt: false }),
  });

  const state = await readSettingsWindowState();

  assert.deepEqual({ ...state.settings }, { x: 232, y: 232, width: 723, height: 804 });
  assert.equal(state.authPrompt, false);
});

test("reports the settings window as gone once it is closed", async () => {
  const { readSettingsWindowState } = load({
    execFile: report({ settings: null, authPrompt: false }),
  });

  const state = await readSettingsWindowState();

  assert.equal(state.settings, null);
});

test("reports an authorization prompt so the overlay can get out of its way", async () => {
  const { readSettingsWindowState } = load({
    execFile: report({ settings: { x: 0, y: 0, width: 700, height: 800 }, authPrompt: true }),
  });

  assert.equal((await readSettingsWindowState()).authPrompt, true);
});

test("unreadable output is reported as unknown, not as a closed window", async () => {
  // A parse failure must not read as "settings closed", which would close the
  // overlay out from under the user.
  const { readSettingsWindowState } = load({ execFile: succeed("not json\n") });

  assert.equal(await readSettingsWindowState(), null);
});

test("a helper that cannot run is unknown rather than closed", async () => {
  const { readSettingsWindowState } = load({
    execFile: (callback) => callback(Object.assign(new Error("boom"), { code: 1 }), "", ""),
  });

  assert.equal(await readSettingsWindowState(), null);
});

test("never blocks the guide: the helper runs under a timeout", async () => {
  const { readSettingsWindowState, calls } = load({
    execFile: report({ settings: null, authPrompt: false }),
  });

  await readSettingsWindowState();

  assert.ok(calls[0].options.timeout > 0);
});

test("is macOS only, and never spawns anything elsewhere", async () => {
  const { readSettingsWindowState, calls } = load({
    platform: "win32",
    execFile: report({ settings: null, authPrompt: false }),
  });

  assert.equal(await readSettingsWindowState(), null);
  assert.equal(calls.length, 0);
});

test("reports nothing when the helper binary is missing from the bundle", async () => {
  const { readSettingsWindowState, calls } = load({
    binary: null,
    execFile: report({ settings: null, authPrompt: false }),
  });

  assert.equal(await readSettingsWindowState(), null);
  assert.equal(calls.length, 0);
});

test("hands the helper the app's own pid so it can tell self from other apps", async () => {
  // Window owner names are localized ("Systemeinstellungen" on a German Mac), so
  // the helper classifies by process instead; it needs to know which one we are.
  const { readSettingsWindowState, calls } = load({
    execFile: report({ settings: null, authPrompt: false, frontmost: "self" }),
  });

  await readSettingsWindowState();

  // The args array is built inside the vm context, so compare contents only.
  assert.deepEqual([...calls[0].args], ["4242"]);
});

test("reads the front app as a classification, never as a window title", async () => {
  const front = async (frontmost) =>
    (
      await load({
        execFile: report({ settings: null, authPrompt: false, frontmost }),
      }).readSettingsWindowState()
    ).frontmost;

  assert.equal(await front("settings"), "settings");
  assert.equal(await front("self"), "self");
  assert.equal(await front("other"), "other");
  assert.equal(await front("Safari"), null);
});

test("resolves the helper binary once, not on every poll", async () => {
  // The resolver logs each lookup; at two polls a second that is 120 log lines
  // a minute for the whole time the overlay is open.
  const { readSettingsWindowState, resolves } = load({
    execFile: report({ settings: null, authPrompt: false }),
  });

  await readSettingsWindowState();
  await readSettingsWindowState();

  assert.equal(resolves.length, 1);
});

test("reports whether the helper is available so the guide can fall back up front", () => {
  assert.equal(load({ execFile: report({}) }).isSettingsWindowStateAvailable(), true);
  assert.equal(
    load({ binary: null, execFile: report({}) }).isSettingsWindowStateAvailable(),
    false
  );
  assert.equal(
    load({ platform: "win32", execFile: report({}) }).isSettingsWindowStateAvailable(),
    false
  );
});

test("reads whether System Settings is still running while its window is off screen", async () => {
  const running = await load({
    execFile: report({ settings: null, authPrompt: false, settingsRunning: true }),
  }).readSettingsWindowState();
  const closed = await load({
    execFile: report({ settings: null, authPrompt: false }),
  }).readSettingsWindowState();

  assert.equal(running.settingsRunning, true);
  assert.equal(closed.settingsRunning, false);
});
