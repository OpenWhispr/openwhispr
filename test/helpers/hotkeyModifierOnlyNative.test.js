const test = require("node:test");
const assert = require("node:assert/strict");

// A modifier-only chord has no regular key, so Electron cannot build an
// accelerator for it. Registering one always fails; the low-level listener is
// what actually watches these on Windows and Linux. Any register() call reaching
// this stub for such a hotkey is the bug this guards against.
const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
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

const noop = () => {};
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (value) => Object.defineProperty(process, "platform", { value, configurable: true });

test.beforeEach(() => registered.clear());
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

for (const platform of ["win32", "linux"]) {
  test(`modifier-only chords skip globalShortcut on ${platform} and go to the native listener`, async () => {
    setPlatform(platform);
    const mgr = new HotkeyManager();

    const result = await mgr.registerSlot("dictation", "Control+Super", noop);

    assert.equal(result.success, true);
    assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["Control+Super"]);
    assert.equal(registered.size, 0, "globalShortcut must not be used for a modifier-only chord");
    assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["Control+Super"]);
  });
}

test("a right-side single modifier also reaches the native listener on linux", async () => {
  setPlatform("linux");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("dictation", "RightControl", noop);

  assert.equal(result.success, true);
  assert.equal(registered.size, 0);
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});
