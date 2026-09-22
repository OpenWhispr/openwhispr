const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function loadManager(t, platform, { available = true, throws = false } = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const modulePath = require.resolve(
    `../../src/helpers/${platform === "win32" ? "windows" : "linux"}KeyManager`
  );
  delete require.cache[modulePath];
  const children = [];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./debugLogger") return { debug() {}, warn() {}, error() {} };
    if (request === "fs")
      return {
        statSync() {
          if (!available) throw new Error("missing");
          return { isFile: () => true };
        },
      };
    if (request === "child_process")
      return {
        spawn(_path, [key]) {
          if (throws) throw new Error("spawn failed");
          const child = new EventEmitter();
          child.key = key;
          child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
          child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
          child.kill = () => {
            child.killed = true;
          };
          children.push(child);
          return child;
        },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  let manager;
  try {
    manager = new (require(modulePath))();
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => manager.stop());
  const failures = [];
  manager.on("failed", (failure) => failures.push(failure));
  return { manager, children, failures };
}

for (const platform of ["win32", "linux"]) {
  test(`${platform}: readiness adds candidate readers without replacing current readers`, async (t) => {
    const { manager, children } = loadManager(t, platform);
    const first = manager.ensureReady(["F9"]);
    children[0].stdout.emit("data", "READY\n");
    assert.equal(await first, true);
    const candidate = manager.ensureReady(["F10"]);
    assert.equal(children[0].killed, undefined);
    children[1].stdout.emit("data", "READY\n");
    assert.equal(await candidate, true);
    manager.setKeys(["F10"]);
    assert.equal(children[0].killed, true);
    assert.equal(children[1].killed, undefined);
  });

  for (const failure of ["missing", "spawn", "error", "nonzero", "signal", "zero", "timeout"]) {
    test(`${platform}: ${failure} settles readiness and stops the failed reader`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { manager, children, failures } = loadManager(t, platform, {
        available: failure !== "missing",
        throws: failure === "spawn",
      });
      const ready = manager.ensureReady(["F9"]);
      const child = children[0];
      if (failure === "error") child.emit("error", new Error("rejected"));
      if (failure === "nonzero") child.emit("exit", 1, null);
      if (failure === "signal") child.emit("exit", null, "SIGKILL");
      if (failure === "zero") child.emit("exit", 0, null);
      if (failure === "timeout") t.mock.timers.tick(5000);
      assert.equal(await ready, false);
      assert.equal(manager.canWatch("F9"), false);
      assert.equal(failures.length, 1);
      assert.equal(manager.isCurrentFailure(failures[0]), true);
      assert.equal(manager.listeners.size, 0);
      if (child) assert.equal(child.killed, true);
      manager.setKeys(["F9"]);
      assert.equal(
        children.length,
        child ? 1 : 0,
        "ordinary reconciliation does not retry failures"
      );
    });
  }

  test(`${platform}: failure remains unavailable after cleanup and through a pending retry`, async (t) => {
    const { manager, children } = loadManager(t, platform);
    const first = manager.ensureReady(["F9"]);
    children[0].emit("error", new Error("hook rejected"));
    assert.equal(await first, false);
    manager.setKeys([]);
    assert.equal(manager.readiness.size, 0);
    assert.equal(manager.canWatch("F9"), false);
    manager.setKeys(["F9"]);
    assert.equal(children.length, 1, "ordinary reconciliation cannot retry a cleaned-up failure");
    const retry = manager.ensureReady(["F9"]);
    assert.equal(children.length, 2);
    assert.equal(
      manager.canWatch("F9"),
      false,
      "a pending retry has no successful capability verdict"
    );
    children[1].stdout.emit("data", "READY\n");
    assert.equal(await retry, true);
    assert.equal(manager.canWatch("F9"), true);
  });

  test(`${platform}: intentional stop cancels readiness without a failure`, async (t) => {
    const { manager, children, failures } = loadManager(t, platform);
    const ready = manager.ensureReady(["F9"]);
    manager.setKeys([]);
    children[0].emit("exit", 0, "SIGTERM");
    assert.equal(await ready, false);
    assert.equal(failures.length, 0);
  });

  test(`${platform}: a fresh explicit attempt ignores stale child events`, async (t) => {
    const { manager, children, failures } = loadManager(t, platform);
    const first = manager.ensureReady(["F9"]);
    children[0].emit("error", new Error("failed"));
    assert.equal(await first, false);
    const second = manager.ensureReady(["F9"]);
    const keys = [];
    manager.on("key-down", (key) => keys.push(key));
    children[0].stdout.emit("data", "READY\nKEY_DOWN\n");
    children[0].emit("exit", 1, null);
    children[0].emit("error", new Error("late error"));
    assert.equal(manager.isCurrentFailure(failures[0]), false);
    assert.deepEqual(keys, []);
    children[1].stdout.emit("data", "READY\nKEY_DOWN\n");
    assert.equal(await second, true);
    assert.deepEqual(keys, ["F9"]);
    assert.equal(failures.length, 1);
  });
}

test("Linux NO_PERMISSION followed by READY in one chunk stays failed", async (t) => {
  const { manager, children, failures } = loadManager(t, "linux");
  const ready = manager.ensureReady(["F9"]);
  let readyEvents = 0;
  manager.on("ready", () => readyEvents++);
  children[0].stdout.emit("data", "NO_PERMISSION\nREADY\nKEY_DOWN\n");
  assert.equal(await ready, false);
  assert.equal(readyEvents, 0);
  assert.equal(failures.length, 1);
  const retry = manager.ensureReady(["F9"]);
  children[1].stdout.emit("data", "READY\n");
  assert.equal(await retry, true);
});
