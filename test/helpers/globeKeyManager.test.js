const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const managerModulePath = require.resolve("../../src/helpers/globeKeyManager");
const originalLoad = Module._load;
const originalPlatform = process.platform;

// resolveListenerBinary walks real candidate paths, so the first one is pinned
// here instead of depending on whether the binary happens to be built.
const LISTENER_PATH = path.join(
  path.dirname(managerModulePath),
  "..",
  "..",
  "resources",
  "bin",
  "macos-globe-listener"
);

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function makeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    writes: [],
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
  });
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
  };
  return child;
}

function installFakeTimers() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];

  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    timer.cleared = true;
  };

  return {
    timers,
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

// Returns the manager plus the spawn calls it made, so tests can assert on the
// arguments handed to the native listener.
function loadManager({ markerExists = true } = {}) {
  delete require.cache[managerModulePath];
  setPlatform("darwin");

  const spawnCalls = [];
  const spawn = (command, args) => {
    const child = makeChild();
    spawnCalls.push({ command, args, child });
    return child;
  };

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    if (request === "child_process") {
      return { ...childProcess, spawn };
    }
    if (request === "fs") {
      return {
        constants: { X_OK: 1 },
        statSync: () => ({ isFile: () => true }),
        existsSync: () => markerExists,
        accessSync() {},
        // Architecture verification is best-effort; failing it here keeps the
        // test independent of the host CPU.
        openSync() {
          throw new Error("unavailable in test");
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const GlobeKeyManager = require(managerModulePath);
    return { GlobeKeyManager, spawnCalls };
  } finally {
    Module._load = originalLoad;
  }
}

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
});

test("spawn args carry the state path and omit suppression by default", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();
  manager.stop();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, LISTENER_PATH);
  assert.deepEqual(spawnCalls[0].args, ["--globe-preference-state", "/tmp/state.json"]);
});

test("leftover preference recovery uses a one-shot helper without starting the listener", async () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  const recovery = manager.restoreLeftoverSystemPreference();

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [
    "--globe-preference-state",
    "/tmp/state.json",
    "--restore-leftover-globe-preference",
  ]);
  assert.equal(manager.process, null);

  spawnCalls[0].child.emit("exit", 0, null);
  await recovery;

  assert.equal(manager.process, null);
});

test("timed-out preference recovery waits for the helper to exit", async () => {
  const fakeTimers = installFakeTimers();
  try {
    const { GlobeKeyManager, spawnCalls } = loadManager();
    const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });
    const recovery = manager.restoreLeftoverSystemPreference();
    let resolved = false;
    recovery.then(() => {
      resolved = true;
    });

    assert.equal(fakeTimers.timers[0].delay, 2000);
    fakeTimers.timers[0].callback();
    await Promise.resolve();

    assert.equal(resolved, false, "startup must wait until the one-shot helper exits");
    assert.equal(fakeTimers.timers[1].delay, 1000);
    assert.equal(spawnCalls[0].child.killed, true);
    assert.equal(spawnCalls[0].child.killSignal, "SIGKILL");

    spawnCalls[0].child.emit("exit", null, "SIGKILL");
    await recovery;

    assert.equal(resolved, true);
    assert.equal(fakeTimers.timers[0].cleared, true);
    assert.equal(fakeTimers.timers[1].cleared, true);
    assert.equal(manager.process, null);
  } finally {
    fakeTimers.restore();
  }
});

test("an unconfirmed recovery termination blocks the long-lived listener", async () => {
  const fakeTimers = installFakeTimers();
  try {
    const { GlobeKeyManager, spawnCalls } = loadManager();
    const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });
    const errors = [];
    manager.on("error", (error) => errors.push(error));

    const recovery = manager.restoreLeftoverSystemPreference();
    fakeTimers.timers[0].callback();
    fakeTimers.timers[1].callback();
    await recovery;

    manager.start();

    assert.equal(spawnCalls.length, 1, "a second helper must not race the wedged recovery");
    assert.match(errors[0].message, /preference recovery could not be terminated/);
    assert.equal(manager.process, null);
  } finally {
    fakeTimers.restore();
  }
});

test("leftover preference recovery is skipped without a marker or off macOS", async () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();

  await manager.restoreLeftoverSystemPreference();
  setPlatform("win32");
  await new GlobeKeyManager({
    preferenceStatePath: "/tmp/state.json",
  }).restoreLeftoverSystemPreference();

  assert.equal(spawnCalls.length, 0);

  const withoutMarker = loadManager({ markerExists: false });
  await new withoutMarker.GlobeKeyManager({
    preferenceStatePath: "/tmp/state.json",
  }).restoreLeftoverSystemPreference();
  assert.equal(withoutMarker.spawnCalls.length, 0);
});

test("spawn args include mouse buttons, a spaced state path, and the suppression flag", () => {
  const statePath =
    "/Users/a b/Library/Application Support/open whispr/globe-preference-state.json";
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: statePath });

  manager.setConfiguration({
    mouseButtons: ["MouseButton5", "MouseButton4", "MouseButton4"],
    suppressGlobeAction: true,
  });
  manager.start();
  manager.stop();

  // The path stays a single argv entry, so spaces need no escaping.
  assert.deepEqual(spawnCalls[0].args, [
    "MouseButton4,MouseButton5",
    "--globe-preference-state",
    statePath,
    "--suppress-system-globe-action",
  ]);
});

test("a configuration change reconfigures the running listener instead of restarting it", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();
  manager.setConfiguration({ mouseButtons: ["MouseButton4"], suppressGlobeAction: true });

  assert.equal(spawnCalls.length, 1, "listener should not be respawned");
  assert.deepEqual(spawnCalls[0].child.stdin.writes, [
    '{"mouseButtons":["MouseButton4"],"suppressGlobeAction":true}\n',
  ]);

  manager.stop();
});

test("an unchanged configuration writes nothing", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.setConfiguration({ mouseButtons: ["MouseButton4"], suppressGlobeAction: true });
  manager.start();
  // Same values, different order — must not look like a change.
  manager.setConfiguration({ mouseButtons: ["MouseButton4"], suppressGlobeAction: true });

  assert.deepEqual(spawnCalls[0].child.stdin.writes, []);

  manager.stop();
});

test("successive changes each reach the listener as one full-state line", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();
  manager.setConfiguration({ suppressGlobeAction: true });
  manager.setConfiguration({ mouseButtons: ["MouseButton5"], suppressGlobeAction: true });
  manager.setConfiguration({});

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].child.stdin.writes, [
    '{"mouseButtons":[],"suppressGlobeAction":true}\n',
    '{"mouseButtons":["MouseButton5"],"suppressGlobeAction":true}\n',
    '{"mouseButtons":[],"suppressGlobeAction":false}\n',
  ]);

  manager.stop();
});

test("a dead stdin falls back to respawning with the new configuration", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();
  spawnCalls[0].child.stdin.writable = false;
  manager.setConfiguration({ suppressGlobeAction: true });

  assert.equal(spawnCalls.length, 2);
  // The old listener has to be terminated so it restores the system preference.
  assert.equal(spawnCalls[0].child.killed, true);
  assert.deepEqual(spawnCalls[1].args, [
    "--globe-preference-state",
    "/tmp/state.json",
    "--suppress-system-globe-action",
  ]);

  manager.stop();
});

test("a restart picks up the latest configuration", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();
  manager.stop();
  manager.setConfiguration({ mouseButtons: ["MouseButton4"], suppressGlobeAction: true });
  manager.start();
  manager.stop();

  assert.deepEqual(spawnCalls[1].args, [
    "MouseButton4",
    "--globe-preference-state",
    "/tmp/state.json",
    "--suppress-system-globe-action",
  ]);
});

test("no state path means no state argument", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();

  manager.setConfiguration({ suppressGlobeAction: true });
  manager.start();
  manager.stop();

  assert.deepEqual(spawnCalls[0].args, ["--suppress-system-globe-action"]);
});

test("the listener is not started off macOS", () => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  setPlatform("win32");
  const manager = new GlobeKeyManager({ preferenceStatePath: "/tmp/state.json" });

  manager.start();

  assert.equal(spawnCalls.length, 0);
});

test("only observable compound terminals get native release tokens", () => {
  const { GlobeKeyManager } = loadManager();

  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Control+Space"), "space");
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Cmd+Shift+F8"), "f8");
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Cmd+Escape"), "esc");
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Ctrl+A"), "a");
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Ctrl+Left"), "left");
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("F8"), null);
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Ctrl+Shift"), null);
  assert.equal(GlobeKeyManager.getMacCompoundTerminalKey("Ctrl+MediaNextTrack"), null);
});

test("only the configured compound terminals are sent to the native listener", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());

  manager.setConfiguration({ compoundKeys: ["space", "f8", "space", "not-a-key"] });
  manager.start();
  assert.deepEqual(spawnCalls[0].args, ["--compound-key", "f8", "--compound-key", "space"]);

  manager.setConfiguration({ compoundKeys: ["a"] });
  manager.setConfiguration({});
  manager.stop();

  assert.deepEqual(
    spawnCalls[0].child.stdin.writes.map((line) => JSON.parse(line)),
    [
      { mouseButtons: [], suppressGlobeAction: false, compoundKeys: ["a"] },
      { mouseButtons: [], suppressGlobeAction: false },
    ]
  );
});

test("the listener forwards complete compound releases and right-modifier interruptions", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());
  const events = [];
  manager.setConfiguration({ compoundKeys: ["space"] });
  manager.on("compound-key-up", (key) => events.push(["compound-key-up", key]));
  manager.on("right-modifier-interrupted", (modifier) =>
    events.push(["right-modifier-interrupted", modifier])
  );
  manager.start();
  const { stdout } = spawnCalls[0].child;

  stdout.emit("data", "RIGHT_MOD_INTER");
  stdout.emit("data", "RUPTED:RightOption\nCOMPOUND_KEY_UP:spa");
  assert.deepEqual(events, [["right-modifier-interrupted", "RightOption"]]);
  stdout.emit("data", "ce\nCOMPOUND_KEY_UP:a\n");
  manager.setConfiguration({});
  stdout.emit("data", "COMPOUND_KEY_UP:space\n");
  manager.stop();

  assert.deepEqual(events, [
    ["right-modifier-interrupted", "RightOption"],
    ["compound-key-up", "space"],
  ]);
});

test("the listener forwards each watched modifier press after a complete native line", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());
  const presses = [];
  manager.setConfiguration({ compoundKeys: ["space"] });
  manager.on("modifier-down", (modifier) => presses.push(modifier));
  manager.start();
  const { stdout } = spawnCalls[0].child;

  stdout.emit("data", "MODIFIER_DOWN:unknown\nMODIFIER_DOWN:shi");
  assert.deepEqual(presses, []);
  stdout.emit("data", "ft\nMODIFIER_DOWN:fn\n");
  assert.deepEqual(presses, ["shift", "fn"]);
});

test("the listener distinguishes Globe tap interruptions from ordinary Hold interruptions", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());
  const events = [];
  manager.on("globe-tap-interrupted", () => events.push("tap"));
  manager.on("globe-interrupted", () => events.push("keyboard"));
  manager.start();
  const { stdout } = spawnCalls[0].child;

  stdout.emit("data", "FN_TAP_INTERRUPTED_extra\nFN_TAP_INTER");
  assert.deepEqual(events, []);
  stdout.emit("data", "RUPTED\nFN_INTERRUPTED\n");

  assert.deepEqual(events, ["tap", "keyboard"]);
});

test("keyboard observation requires an exact ready event from the current listener", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());
  const statuses = [];
  manager.on("keyboard-monitor-status-changed", (status) => statuses.push(status));

  manager.start();
  const child = spawnCalls[0].child;
  assert.equal(manager.hasKeyboardMonitor, false);
  child.stdout.emit("data", "KEY_MONITOR_READY_extra\n");
  assert.equal(manager.hasKeyboardMonitor, false);
  child.stdout.emit("data", "KEY_MONITOR_READY\n");
  assert.equal(manager.hasKeyboardMonitor, true);

  child.emit("exit", null, "SIGTERM");
  assert.equal(manager.hasKeyboardMonitor, false);
  assert.deepEqual(statuses, ["ready", "unavailable"]);
  manager.start();
  child.stdout.emit("data", "KEY_MONITOR_READY\n");
  assert.equal(manager.hasKeyboardMonitor, false);
  spawnCalls[1].child.stdout.emit("data", "KEY_MONITOR_READY\n");
  assert.equal(manager.hasKeyboardMonitor, true);
  manager.stop();
  manager.stop();
  assert.equal(manager.hasKeyboardMonitor, false);
  assert.deepEqual(statuses, ["ready", "unavailable", "pending", "ready", "unavailable"]);
});

test("keyboard monitoring reports startup, refusal and recovery separately", (t) => {
  const { GlobeKeyManager, spawnCalls } = loadManager();
  const manager = new GlobeKeyManager();
  t.after(() => manager.stop());
  const statuses = [];
  manager.on("keyboard-monitor-status-changed", (status) => statuses.push(status));

  manager.start();
  assert.equal(manager.keyboardMonitorStatus, "pending");
  const first = spawnCalls[0].child;
  first.stdout.emit("data", "KEY_MONITOR_UNAVAILABLE_extra\nKEY_MONITOR_UNAVAIL");
  assert.deepEqual(statuses, []);
  first.stdout.emit("data", "ABLE\nKEY_MONITOR_UNAVAILABLE\n");

  assert.equal(manager.keyboardMonitorStatus, "unavailable");
  assert.equal(manager.hasKeyboardMonitor, false);
  assert.equal(manager.process, first, "an unavailable keyboard monitor still serves Hold");
  assert.deepEqual(statuses, ["unavailable"]);

  first.emit("exit", null, "SIGTERM");
  manager.start();
  assert.equal(manager.keyboardMonitorStatus, "pending");
  first.stdout.emit("data", "KEY_MONITOR_READY\n");
  first.stderr.emit("data", "Failed to create event monitor");
  first.emit("error", new Error("stale child failed"));
  const second = spawnCalls[1].child;
  assert.equal(manager.process, second);
  assert.equal(manager.keyboardMonitorStatus, "pending");
  second.stdout.emit("data", "KEY_MONITOR_READY\nKEY_MONITOR_READY\n");

  assert.equal(manager.keyboardMonitorStatus, "ready");
  assert.equal(manager.hasKeyboardMonitor, true);
  second.emit("exit", null, "SIGTERM");
  assert.equal(manager.keyboardMonitorStatus, "unavailable");
  assert.deepEqual(statuses, ["unavailable", "pending", "ready", "unavailable"]);
});
