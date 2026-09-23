const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");

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

function startWatching(key = "Control+Space") {
  const { LinuxKeyManager, spawnCalls } = loadManager();
  const manager = new LinuxKeyManager();
  manager.setKeys([key]);
  assert.equal(spawnCalls.length, 1, "one listener process per watched key");

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

// checkAvailability mirrors the C listener's NO_PERMISSION rule, so these pin
// the states it has to tell apart. loadManager's `fs` stub only carries
// statSync, so these load the manager against the real fs and patch it per test.
function loadManagerWithRealFs() {
  delete require.cache[managerModulePath];
  setPlatform("linux");

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });

// sysfs capability bitmaps as the kernel prints them: hex words, most
// significant first, unpadded. A laptop keyboard's lowest key word has every bit
// but KEY_RESERVED set, a value a double cannot hold exactly.
const KEYBOARD_CAPABILITIES = {
  ev: "120013",
  key: "402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe",
};
const GAMEPAD_CAPABILITIES = { ev: "20000b", key: "7cdb000000000000 0 0 0 0" };

// Patch only the paths under test; everything else keeps the real behaviour so
// node:test's own fs use is untouched.
function stubBinaryFound(t, found) {
  const real = fs.statSync;
  t.mock.method(fs, "statSync", (target, ...rest) => {
    if (!String(target).includes("linux-key-listener")) return real.call(fs, target, ...rest);
    if (!found) throw enoent();
    return { isFile: () => true };
  });
}

function stubInputDir(t, { entries, readable = [], keyboards = readable, sysfs = true }) {
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (target, ...rest) => {
    if (String(target) !== "/dev/input") return realReaddir.call(fs, target, ...rest);
    if (!entries) throw enoent();
    return entries;
  });

  const realAccess = fs.accessSync;
  t.mock.method(fs, "accessSync", (target, ...rest) => {
    if (!String(target).startsWith("/dev/input/")) return realAccess.call(fs, target, ...rest);
    if (!readable.includes(String(target))) throw eacces();
  });

  // Every /sys/class/input read is answered here, so a Linux runner's own
  // devices never leak into the result.
  const realReadFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...rest) => {
    if (!String(target).startsWith("/sys/class/input/")) {
      return realReadFile.call(fs, target, ...rest);
    }
    const match = /^\/sys\/class\/input\/(event\d+)\/device\/capabilities\/(ev|key)$/.exec(
      String(target)
    );
    if (!sysfs || !match) throw enoent();
    const [, node, bitmap] = match;
    const isKeyboard = keyboards.includes(`/dev/input/${node}`);
    return `${(isKeyboard ? KEYBOARD_CAPABILITIES : GAMEPAD_CAPABILITIES)[bitmap]}\n`;
  });
}

test("checkAvailability reports a missing listener binary", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, false);

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), {
    available: false,
    reason: "binary_missing",
  });
});

test("checkAvailability reports denied access when no event node is readable", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, { entries: ["event0", "event1", "mice"] });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), {
    available: false,
    reason: "input_access_denied",
  });
});

test("checkAvailability is available when a single event node is readable", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, { entries: ["event0", "event1"], readable: ["/dev/input/event1"] });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), { available: true });
});

// The C listener treats both of these as "wait for hotplug", not as a failure.
test("checkAvailability does not block when /dev/input holds no event nodes", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, { entries: ["mice"] });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), { available: true });
});

test("checkAvailability does not block when /dev/input cannot be read", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, { entries: null });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), { available: true });
});

// systemd's uaccess rule (rules.d/70-uaccess.rules.in) grants the session user
// every joystick node, so a gamepad is readable where keyboards are not. The C
// listener skips it as a non-keyboard and prints NO_PERMISSION; the probe must
// reach the same verdict.
test("checkAvailability denies access when only a gamepad node is readable", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, {
    entries: ["event0", "event1"],
    readable: ["/dev/input/event1"],
    keyboards: [],
  });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), {
    available: false,
    reason: "input_access_denied",
  });
});

test("checkAvailability finds a readable keyboard past a readable gamepad", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, {
    entries: ["event0", "event1", "event2"],
    readable: ["/dev/input/event0", "/dev/input/event2"],
    keyboards: ["/dev/input/event2"],
  });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), { available: true });
});

// Without /sys (some sandboxes) a readable node might be a keyboard, and a false
// "denied" would refuse a hotkey the listener can serve.
test("checkAvailability trusts a readable node when sysfs cannot describe it", (t) => {
  const LinuxKeyManager = loadManagerWithRealFs();
  stubBinaryFound(t, true);
  stubInputDir(t, {
    entries: ["event0", "event1"],
    readable: ["/dev/input/event1"],
    keyboards: [],
    sysfs: false,
  });

  assert.deepEqual(new LinuxKeyManager().checkAvailability(), { available: true });
});
