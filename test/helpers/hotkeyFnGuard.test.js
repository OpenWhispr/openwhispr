const test = require("node:test");
const assert = require("node:assert/strict");

// Same electron stub as the other hotkeyManager suites: `registered` holds the
// callback globalShortcut would fire, so a test can invoke it directly.
const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

test.beforeEach(() => {
  registered.clear();
});

test("an Fn combination is rejected without registering its base key", async () => {
  const manager = new HotkeyManager();

  const result = await manager.registerSlot("dictation", "Fn+A", () => {}, { atomic: true });

  assert.equal(result.success, false);
  assert.equal(result.reason, "fn_combination_unsupported");
  assert.deepEqual([...registered.keys()], []);
});

test("rejecting an Fn combination preserves the slot's previous binding", async () => {
  const manager = new HotkeyManager();
  const fired = [];

  await manager.registerSlot("dictation", "Control+Shift+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });
  const result = await manager.registerSlot("dictation", "Fn+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });

  assert.equal(result.success, false);
  assert.deepEqual([...registered.keys()], ["Control+Shift+A"]);
  registered.get("Control+Shift+A")();
  assert.deepEqual(fired, ["Control+Shift+A"]);
});

test("ordinary hotkeys continue to register normally", async () => {
  const manager = new HotkeyManager();
  const fired = [];

  await manager.registerSlot("dictation", "Control+Shift+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });

  registered.get("Control+Shift+A")();
  assert.deepEqual(fired, ["Control+Shift+A"]);
});
