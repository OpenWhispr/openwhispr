const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "./debugLogger" || request.endsWith("/debugLogger")) {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }
  return originalLoad(request, parent, isMain);
};

const LinuxKeyManager = require("../../src/helpers/linuxKeyManager");

test("LinuxKeyManager exports 5-minute platform ceiling", () => {
  assert.equal(LinuxKeyManager.WATCHDOG_MS, 300000);
  assert.equal(LinuxKeyManager.DEFAULT_WATCHDOG_MS, 300000);

  const manager = new LinuxKeyManager();
  assert.equal(manager.watchdogMs, 300000);
});

test("LinuxKeyManager accepts custom watchdog duration in constructor options", () => {
  const manager = new LinuxKeyManager({ watchdogMs: 15000 });
  assert.equal(manager.watchdogMs, 15000);
});

test("watchdog does not prematurely release at 30 seconds under 5-minute ceiling", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
  });

  const manager = new LinuxKeyManager({ isSupported: true });
  manager.listeners.set("Control+Space", { child: null, watchdog: null });

  let keyUpEmitted = false;
  manager.on("key-up", () => {
    keyUpEmitted = true;
  });

  manager.handleOutputLine("KEY_DOWN", "Control+Space");

  // Advance 30 seconds (old premature timeout)
  t.mock.timers.tick(30000);
  assert.equal(keyUpEmitted, false, "Should not emit key-up at 30s");

  // Advance 60 seconds (1.5 minutes total)
  t.mock.timers.tick(60000);
  assert.equal(keyUpEmitted, false, "Should not emit key-up at 90s");

  // Advance to 300,000 ms (5 minutes total)
  t.mock.timers.tick(210000);
  assert.equal(keyUpEmitted, true, "Should emit key-up at 5-minute ceiling");
});

test("watchdog is cleared when KEY_UP is received before timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
  });

  const manager = new LinuxKeyManager({ isSupported: true, watchdogMs: 300000 });
  manager.listeners.set("Control+Space", { child: null, watchdog: null });

  const events = [];
  manager.on("key-down", (k) => events.push(`down:${k}`));
  manager.on("key-up", (k) => events.push(`up:${k}`));

  manager.handleOutputLine("KEY_DOWN", "Control+Space");
  assert.deepEqual(events, ["down:Control+Space"]);

  // User speaks for 45 seconds and releases key
  t.mock.timers.tick(45000);
  manager.handleOutputLine("KEY_UP", "Control+Space");
  assert.deepEqual(events, ["down:Control+Space", "up:Control+Space"]);

  const entry = manager.listeners.get("Control+Space");
  assert.equal(entry.watchdog, null, "Watchdog timer should be cleared");

  // Advance past 5 minutes to verify no extra synthetic key-up fires
  t.mock.timers.tick(300000);
  assert.deepEqual(events, ["down:Control+Space", "up:Control+Space"]);
});

test("stopping a key cancels any active watchdog", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
  });

  const manager = new LinuxKeyManager({ isSupported: true });
  manager.listeners.set("Control+Space", { child: { kill: () => {} }, watchdog: null });

  let keyUpFired = false;
  manager.on("key-up", () => {
    keyUpFired = true;
  });

  manager.handleOutputLine("KEY_DOWN", "Control+Space");
  assert.ok(manager.listeners.get("Control+Space").watchdog !== null);

  manager._stopKey("Control+Space");
  assert.equal(manager.listeners.has("Control+Space"), false);

  t.mock.timers.tick(350000);
  assert.equal(keyUpFired, false, "Cancelled watchdog should not fire after stop");
});
