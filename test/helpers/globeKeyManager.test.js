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
