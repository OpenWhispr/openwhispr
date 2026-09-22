const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const managerModulePath = require.resolve("../../src/helpers/linuxKeyManager");
const originalLoad = Module._load;
const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// Drives the real setKeys path with a stubbed listener binary, so the tests
// exercise the same wiring production uses rather than poking listener state.
function loadManager({ available = true } = {}) {
  delete require.cache[managerModulePath];
  setPlatform("linux");

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
      return { statSync: () => ({ isFile: () => available }) };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const LinuxKeyManager = require(managerModulePath);
    return { LinuxKeyManager, spawnCalls };
  } finally {
    Module._load = originalLoad;
  }
}

function startWatching(key = "Control+Space") {
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const manager = new LinuxKeyManager();
  manager.setKeys([key]);
  assert.equal(spawnCalls.length, 1, "one listener process per watched key");
  spawnCalls[0].child.stdout.emit("data", "READY\n");

  const events = [];
  manager.on("key-down", (k) => events.push(`down:${k}`));
  manager.on("key-up", (k) => events.push(`up:${k}`));

  return { manager, events, child: spawnCalls[0].child };
}

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
});

// Regression pin for #1594 / #2047. A watchdog here used to synthesize a release
// (at 30s, later 5min), which both truncated long holds and made a forced stop
// indistinguishable from the user letting go. The ceiling belongs to
// windowManager's MAX_PUSH_DURATION_MS, which can report that it forced the stop.
test("a held key is never released by this listener, however long it is held", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { events, child } = startWatching();
  child.stdout.emit("data", "KEY_DOWN\n");

  t.mock.timers.tick(30_000);
  assert.deepEqual(events, ["down:Control+Space"], "no release at the old 30s watchdog");

  t.mock.timers.tick(300_000);
  assert.deepEqual(events, ["down:Control+Space"], "no release at the push-to-talk ceiling");

  t.mock.timers.tick(3_600_000);
  assert.deepEqual(events, ["down:Control+Space"], "no release an hour in");
});

test("a physical release is relayed, and nothing follows it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { events, child } = startWatching();
  child.stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(45_000);
  child.stdout.emit("data", "KEY_UP\n");

  assert.deepEqual(events, ["down:Control+Space", "up:Control+Space"]);

  t.mock.timers.tick(3_600_000);
  assert.deepEqual(
    events,
    ["down:Control+Space", "up:Control+Space"],
    "no synthetic extra release"
  );
});

test("events split across stdout chunks are still relayed once each", () => {
  const { events, child } = startWatching();

  child.stdout.emit("data", "KEY_DO");
  child.stdout.emit("data", "WN\nKEY_");
  child.stdout.emit("data", "UP\n");

  assert.deepEqual(events, ["down:Control+Space", "up:Control+Space"]);
});

test("dropping a key kills its listener process and stops tracking it", () => {
  const { manager, child } = startWatching();

  manager.setKeys([]);

  assert.equal(child.killed, true);
  assert.equal(manager.listeners.size, 0);
});

test("a present helper does not imply permission denial", () => {
  const { manager, child } = startWatching();
  assert.equal(manager.isAvailable(), true);
  assert.equal(manager.permissionDenied, false);
  child.stdout.emit("data", "READY\n");
  assert.equal(manager.permissionDenied, false);
});

test("a missing helper is unavailable without a permission diagnosis", () => {
  const { LinuxKeyManager, spawnCalls } = loadManager({ available: false });
  const manager = new LinuxKeyManager();
  let denied = false;
  manager.on("permission-denied", () => {
    denied = true;
  });
  manager.setKeys(["Control+Space"]);
  assert.equal(manager.isAvailable(), false);
  assert.equal(manager.permissionDenied, false);
  assert.equal(denied, false);
  assert.equal(spawnCalls.length, 0);
});

test("permission denial survives READY, stopping, and re-registering until a new manager", () => {
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const manager = new LinuxKeyManager();
  manager.setKeys(["Control+Space"]);
  const observed = [];
  manager.on("permission-denied", () => observed.push(manager.permissionDenied));
  // The native helper reports READY even immediately after NO_PERMISSION.
  spawnCalls[0].child.stdout.emit("data", "NO_PER");
  spawnCalls[0].child.stdout.emit("data", "MISSION\nREADY\n");
  assert.deepEqual(observed, [true], "the denial is recorded before notifying renderers");
  assert.equal(manager.permissionDenied, true);
  manager.stop();
  assert.equal(manager.permissionDenied, true);
  manager.setKeys(["F9"]);
  spawnCalls[1].child.stdout.emit("data", "READY\n");
  assert.equal(manager.permissionDenied, true);
  assert.equal(new LinuxKeyManager().permissionDenied, false);
});
