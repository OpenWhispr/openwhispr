const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(platform, { spawnError, keys } = {}) {
  const children = [];
  const timers = [];
  let spawnCalls = 0;
  const context = {
    module: { exports: {} },
    __dirname,
    process: { platform, arch: "x64" },
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    require(name) {
      if (name === "./debugLogger") return { debug() {}, warn() {}, error() {} };
      if (name === "child_process") {
        return {
          spawn() {
            spawnCalls++;
            if (spawnError) throw spawnError;
            const child = new EventEmitter();
            child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
            child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
            child.kill = () => {
              child.killed = true;
            };
            children.push(child);
            return child;
          },
        };
      }
      return require(name);
    },
  };
  const file = platform === "linux" ? "linuxKeyManager.js" : "windowsKeyManager.js";
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../src/helpers", file), "utf8"),
    context
  );
  const manager = new context.module.exports();
  manager.resolveListenerBinary = () => "/fake/listener";
  const events = [];
  for (const event of ["key-down", "key-up", "ready", "permission-denied", "error"]) {
    manager.on(event, () => events.push(event));
  }
  const startupFailures = [];
  manager.on("startup-failed", () => startupFailures.push(manager.checkAvailability().reason));
  const key = "Control+Space";
  manager.setKeys(keys ?? [key]);
  // Fires every pending timer of exactly `ms`, as if that much time had passed.
  const elapse = (ms) => {
    for (const timer of timers.splice(0)) {
      if (timer.cleared) continue;
      if (timer.ms === ms) timer.callback();
      else timers.push(timer);
    }
  };
  return {
    manager,
    children,
    events,
    key,
    elapse,
    startupFailures,
    spawnCalls: () => spawnCalls,
  };
}

for (const platform of ["linux", "win32"]) {
  for (const action of ["stop", "replace"]) {
    test(`${platform} ignores stdout, partial lines and errors after listener ${action}`, () => {
      const { manager, children, events, key } = fixture(platform);
      const old = children[0];
      old.stdout.emit("data", "KEY_DOWN");
      manager.stop();
      assert.equal(old.killed, true);
      if (action === "replace") manager.setKeys([key]);
      const replacement = manager.listeners.get(key);

      old.stdout.emit("data", "\nREADY\nNO_PERMISSION\nKEY_UP\nKEY_DOWN");
      old.emit("error", new Error("late error"));
      old.emit("exit", 1, null);
      old.emit("close", 1, null);
      assert.deepEqual(events, [], "retired listeners cannot dispatch or report failures");
      assert.equal(manager.listeners.get(key), replacement, "the replacement stays tracked");

      if (action === "replace") {
        children[1].stdout.emit("data", "READY\nKEY_DOWN\nKEY_UP\n");
        assert.deepEqual(events, ["ready", "key-down", "key-up"]);
      }
    });
  }

  test(`${platform} stops dispatching a buffered batch when its listener is stopped`, () => {
    const { manager, children, events } = fixture(platform);
    manager.once("key-down", () => manager.stop());
    children[0].stdout.emit("data", "KEY_DOWN\nKEY_UP\nREADY\n");
    assert.deepEqual(events, ["key-down"]);
  });

  test(`${platform} keeps current-listener trailing output and crash reporting`, () => {
    const { manager, children, events } = fixture(platform);
    children[0].stdout.emit("data", "KEY_UP");
    children[0].emit("exit", null, "SIGSEGV");
    assert.deepEqual(events, [], "wait for stdout to finish before flushing its last line");
    children[0].emit("close", null, "SIGSEGV");
    assert.deepEqual(events, ["key-up", "error"]);
    assert.equal(manager.listeners.size, 0);
  });

  test(`${platform} delivers a final release split across process exit`, () => {
    const { manager, children, events } = fixture(platform);
    children[0].stdout.emit("data", "READY\nKEY_DOWN\nKEY_");
    children[0].emit("exit", 0, null);
    children[0].stdout.emit("data", "UP\n");
    children[0].emit("close", 0, null);

    assert.deepEqual(events, ["ready", "key-down", "key-up"]);
    assert.equal(manager.listeners.size, 0);
  });

  test(`${platform} ignores a retired listener's close after replacing it during drain`, () => {
    const { manager, children, events, key } = fixture(platform);
    const old = children[0];
    old.stdout.emit("data", "KEY_");
    old.emit("exit", 1, null);
    manager.stop();
    manager.setKeys([key]);
    const replacement = manager.listeners.get(key);

    old.stdout.emit("data", "UP\nKEY_DOWN");
    old.emit("close", 1, null);
    assert.deepEqual(events, []);
    assert.equal(manager.listeners.get(key), replacement);

    children[1].stdout.emit("data", "KEY_DOWN\nKEY_UP\n");
    assert.deepEqual(events, ["key-down", "key-up"]);
  });

  test(`${platform} reports a current-listener error only once when close follows`, () => {
    const { manager, children, events } = fixture(platform);
    children[0].emit("error", new Error("spawn failed"));
    children[0].emit("close", -2, null);

    assert.deepEqual(events, ["error"]);
    assert.equal(manager.listeners.size, 0);
  });
}

for (const failure of ["launch denial", "exit before READY"]) {
  test(`win32 reports ${failure} as unavailable and stops retrying for the session`, () => {
    const { manager, children, key } = fixture("win32");
    const failures = [];
    manager.on("startup-failed", () => failures.push(manager.checkAvailability().available));

    const child = children[0];
    if (failure === "launch denial") {
      child.emit("error", Object.assign(new Error("Access is denied"), { code: "EACCES" }));
      child.emit("close", -1, null);
    } else {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }

    assert.equal(manager.checkAvailability().available, false);
    assert.deepEqual(failures, [false], "recovery runs once, after the probe reflects failure");
    manager.setKeys([key]);
    assert.equal(children.length, 1);
  });
}

test("win32 can restart a listener that exits after it has started", () => {
  const { manager, children, key, events, elapse } = fixture("win32");
  children[0].stdout.emit("data", "READY\n");
  elapse(5000);
  children[0].emit("exit", 1, null);
  children[0].emit("close", 1, null);

  assert.equal(manager.checkAvailability().available, true);
  assert.deepEqual(events, ["ready", "error"]);
  manager.setKeys([key]);
  assert.equal(children.length, 2);
});

test("win32 keeps other listeners when one hotkey exits before READY", () => {
  const { manager, children, key, events } = fixture("win32");
  manager.setKeys([key, "UnsupportedKey"]);
  children[1].emit("close", 1, null);
  children[0].stdout.emit("data", "READY\nKEY_DOWN\nKEY_UP\n");

  assert.equal(manager.checkAvailability().available, true);
  assert.deepEqual(events, ["error", "ready", "key-down", "key-up"]);
});

test("win32 falls back when every listener exits before READY", () => {
  const { manager, children, key } = fixture("win32");
  manager.setKeys([key, "F9"]);
  children[0].emit("close", 1, null);
  assert.equal(manager.checkAvailability().available, true);
  children[1].emit("close", 1, null);
  assert.equal(manager.checkAvailability().available, false);
});

test("win32 treats a listener ended soon after READY as blocked", () => {
  const { manager, children, key, events, startupFailures } = fixture("win32");
  children[0].stdout.emit("data", "READY\n");
  children[0].emit("close", 1, null);

  assert.deepEqual(events, ["ready", "error"]);
  assert.deepEqual(startupFailures, ["startup_failed"]);
  assert.equal(manager.checkAvailability().reason, "startup_failed");
  manager.setKeys([key]);
  assert.equal(children.length, 1);
});

test("win32 stops and falls back when a listener never reports READY", () => {
  const { manager, children, elapse, startupFailures } = fixture("win32");
  elapse(10000);

  assert.equal(children[0].killed, true);
  assert.deepEqual(startupFailures, ["startup_failed"]);
  assert.equal(manager.listeners.size, 0);
  children[0].emit("close", null, "SIGTERM");
  assert.deepEqual(
    startupFailures,
    ["startup_failed"],
    "the killed helper's close is not reported again"
  );
});

test("win32 READY clears the launch timeout", () => {
  const { manager, children, elapse } = fixture("win32");
  children[0].stdout.emit("data", "READY\n");
  elapse(10000);
  assert.equal(children[0].killed, undefined);
  assert.equal(manager.checkAvailability().available, true);
});

test("win32 keeps working listeners when another key's launch errors", () => {
  const { manager, children, key, events } = fixture("win32");
  children[0].stdout.emit("data", "READY\n");
  manager.setKeys([key, "F9"]);
  children[1].emit("error", Object.assign(new Error("Too many open files"), { code: "EMFILE" }));

  assert.equal(manager.checkAvailability().available, true);
  assert.equal(manager.listeners.get(key), children[0]);
  assert.deepEqual(events, ["ready", "error"]);
});

test("win32 falls back when spawn throws and starts no further listeners", () => {
  const { manager, events, startupFailures, spawnCalls } = fixture("win32", {
    spawnError: Object.assign(new Error("Access is denied"), { code: "EACCES" }),
    keys: ["Control+Space", "F9"],
  });

  assert.equal(spawnCalls(), 1);
  assert.deepEqual(events, ["error"]);
  assert.deepEqual(startupFailures, ["startup_failed"]);
  assert.equal(manager.listeners.size, 0);
});
