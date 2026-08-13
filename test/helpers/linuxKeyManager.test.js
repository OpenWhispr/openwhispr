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
  child.pid = 4242;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

// Returns the manager class plus the spawn calls it made, with the listener
// binary lookup stubbed so tests don't depend on the binary being built.
function loadManager() {
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
      return { statSync: () => ({ isFile: () => true }) };
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

// Starts a manager watching one key and returns the fake child driving it plus
// the key-up events observed so far.
function startWatchedKey(LinuxKeyManager, spawnCalls, key = "F8") {
  const manager = new LinuxKeyManager();
  const keyUps = [];
  manager.on("key-up", (releasedKey) => keyUps.push(releasedKey));
  manager.setKeys([key]);
  assert.equal(spawnCalls.length, 1);
  return { manager, child: spawnCalls[0].child, keyUps };
}

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
});

test("watchdog budget matches the macOS push-to-talk headroom of 5 minutes", () => {
  const { LinuxKeyManager } = loadManager();
  assert.equal(LinuxKeyManager.WATCHDOG_MS, 300000);
});

test("synthesizes key-up only when the full watchdog budget elapses without KEY_UP", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const { child, keyUps } = startWatchedKey(LinuxKeyManager, spawnCalls);

  child.stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(LinuxKeyManager.WATCHDOG_MS - 1);
  assert.deepEqual(keyUps, []);

  t.mock.timers.tick(1);
  assert.deepEqual(keyUps, ["F8"]);
});

test("a real KEY_UP disarms the watchdog so no second key-up is synthesized", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const { child, keyUps } = startWatchedKey(LinuxKeyManager, spawnCalls);

  child.stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(1000);
  child.stdout.emit("data", "KEY_UP\n");
  assert.deepEqual(keyUps, ["F8"]);

  t.mock.timers.tick(LinuxKeyManager.WATCHDOG_MS);
  assert.deepEqual(keyUps, ["F8"]);
});

test("a repeated KEY_DOWN re-arms the watchdog from the latest press", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const { child, keyUps } = startWatchedKey(LinuxKeyManager, spawnCalls);

  child.stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(LinuxKeyManager.WATCHDOG_MS - 1000);
  child.stdout.emit("data", "KEY_DOWN\n");

  t.mock.timers.tick(LinuxKeyManager.WATCHDOG_MS - 1);
  assert.deepEqual(keyUps, []);

  t.mock.timers.tick(1);
  assert.deepEqual(keyUps, ["F8"]);
});

test("stopping the listener clears a pending watchdog", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const { manager, child, keyUps } = startWatchedKey(LinuxKeyManager, spawnCalls);

  child.stdout.emit("data", "KEY_DOWN\n");
  manager.setKeys([]);
  assert.equal(child.killed, true);

  t.mock.timers.tick(LinuxKeyManager.WATCHDOG_MS);
  assert.deepEqual(keyUps, []);
});
