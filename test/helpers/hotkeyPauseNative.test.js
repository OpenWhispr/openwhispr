const test = require("node:test");
const assert = require("node:assert/strict");

// Electron's accelerator parser has no "Pause" key, so globalShortcut.register
// rejects it on every platform. windows-key-listener.exe watches VK_PAUSE, so on
// Windows a lone Pause belongs to the native listener (#2675). This stub accepts
// everything; a register() call for Pause on Windows is the bug.
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
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

test.beforeEach(() => registered.clear());
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

test("Pause skips globalShortcut on Windows and goes to the native listener", async () => {
  setPlatform("win32");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("dictation", "Pause", noop);

  assert.equal(result.success, true);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["Pause"]);
  assert.equal(registered.size, 0, "Electron cannot register Pause");
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["Pause"]);
});

test("Pause on another slot also reaches the native listener on Windows", async () => {
  setPlatform("win32");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("voiceAgent", "Pause", noop);

  assert.equal(result.success, true);
  assert.equal(registered.size, 0);
  assert.ok(mgr.getNativeListenerKeys("tap").includes("Pause"));
});

test("Pause is refused, not handed to globalShortcut, when the Windows listener is missing", async () => {
  setPlatform("win32");
  const mgr = new HotkeyManager();
  mgr.nativeListenerProbe = () => ({ available: false, reason: "binary_missing" });

  const result = await mgr.registerSlot("dictation", "Pause", noop);

  assert.equal(result.success, false);
  assert.equal(registered.size, 0);
  assert.equal(result.suggestions.includes("Pause"), false, "Pause needs the same listener");
});

// Ctrl+Pause arrives as VK_CANCEL (Break), which the listener never matches, so
// routing it there would register a hotkey that can never fire.
test("Control+Pause is not sent to the Windows listener", async () => {
  setPlatform("win32");
  const mgr = new HotkeyManager();

  await mgr.registerSlot("dictation", "Control+Pause", noop);

  assert.deepEqual(mgr.getNativeListenerKeys("tap"), []);
});
