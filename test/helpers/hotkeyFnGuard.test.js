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

// Electron accelerators cannot express Fn, so "Fn+A" is registered as a bare
// "A". Without the guard, every A keypress fired the hotkey.
test("an Fn+key hotkey registers its bare accelerator", async () => {
  const manager = new HotkeyManager();

  const result = await manager.registerSlot("dictation", "Fn+A", () => {}, { atomic: true });

  assert.equal(result.success, true);
  assert.deepEqual([...registered.keys()], ["A"]);
});

test("Fn+key does not fire when Fn is not held", async () => {
  const manager = new HotkeyManager();
  const fired = [];
  let fnHeld = false;
  manager.setFnHeldProvider(() => fnHeld);

  await manager.registerSlot("dictation", "Fn+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });

  registered.get("A")();
  assert.deepEqual(fired, []);

  fnHeld = true;
  registered.get("A")();
  assert.deepEqual(fired, ["Fn+A"]);
});

test("hotkeys without an Fn prefix are never gated", async () => {
  const manager = new HotkeyManager();
  const fired = [];
  manager.setFnHeldProvider(() => false);

  await manager.registerSlot("dictation", "Control+Shift+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });

  registered.get("Control+Shift+A")();
  assert.deepEqual(fired, ["Control+Shift+A"]);
});

// Platforms with no Fn reporting (everything but macOS) never install a
// provider, and must keep the pre-existing behaviour rather than going dead.
test("without a provider the guard stays out of the way", async () => {
  const manager = new HotkeyManager();
  const fired = [];

  await manager.registerSlot("dictation", "Fn+A", (hotkey) => fired.push(hotkey), {
    atomic: true,
  });

  registered.get("A")();
  assert.deepEqual(fired, ["Fn+A"]);
});
