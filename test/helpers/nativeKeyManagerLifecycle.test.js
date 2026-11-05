const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(platform) {
  const children = [];
  const context = {
    module: { exports: {} },
    __dirname,
    process: { platform, arch: "x64" },
    require(name) {
      if (name === "./debugLogger") return { debug() {}, warn() {}, error() {} };
      if (name === "child_process") {
        return {
          spawn() {
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
  const key = "Control+Space";
  manager.setKeys([key]);
  return { manager, children, events, key };
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
    children[0].stdout.emit("data", "KEY_DOWN\nKEY_");
    children[0].emit("exit", 0, null);
    children[0].stdout.emit("data", "UP\n");
    children[0].emit("close", 0, null);

    assert.deepEqual(events, ["key-down", "key-up"]);
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
