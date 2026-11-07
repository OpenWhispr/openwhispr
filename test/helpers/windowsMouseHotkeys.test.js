const test = require("node:test");
const assert = require("node:assert/strict");
let acceleratorRegistrations = 0;
require.cache[require.resolve("electron")] = {
  exports: {
    app: { isPackaged: false },
    globalShortcut: {
      register: () => {
        acceleratorRegistrations++;
        return true;
      },
      isRegistered: () => false,
    },
    BrowserWindow: { getAllWindows: () => [] },
  },
};
require.cache[require.resolve("../../src/helpers/debugLogger")] = {
  exports: new Proxy({}, { get: () => () => undefined }),
};
const HotkeyManager = require("../../src/helpers/hotkeyManager");
function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}
test("Windows mouse buttons use native listeners in both Tap and Hold, across slots", () =>
  withPlatform("win32", () => {
    const manager = new HotkeyManager();
    manager.slots = new Map([
      ["dictation", { hotkeys: ["MouseButton4", "F8"] }],
      ["agent", { hotkeys: ["MouseButton5"] }],
    ]);
    assert.deepEqual(manager.getNativeListenerKeys("tap"), ["MouseButton4", "MouseButton5"]);
    assert.deepEqual(manager.getNativeListenerKeys("push"), ["MouseButton4", "F8", "MouseButton5"]);
    for (const button of [
      "MouseButton1",
      "MouseButton2",
      "MouseButton3",
      "MouseButton4",
      "MouseButton5",
    ]) {
      assert.deepEqual(
        manager._registerSingleHotkey(button, () => {}),
        { success: true, hotkey: button, accelerator: null }
      );
    }
    assert.equal(acceleratorRegistrations, 0);
  }));
test("Windows rejects mouse shortcuts when the native binary is unavailable", () =>
  withPlatform("win32", () => {
    const manager = new HotkeyManager();
    manager.nativeListenerProbe = () => ({ available: false, reason: "binary_missing" });
    const result = manager._registerSingleHotkey("MouseButton4", () => {});
    assert.equal(result.success, false);
    assert.equal(result.reason, "native_listener_unavailable");
  }));
test("macOS retains its separate mouse listener and Linux refuses unsupported buttons", () => {
  withPlatform("darwin", () => {
    const manager = new HotkeyManager();
    manager.slots = new Map([["dictation", { hotkeys: ["MouseButton4"] }]]);
    assert.equal(manager._registerSingleHotkey("MouseButton4", () => {}).success, true);
    assert.deepEqual(manager.getNativeListenerKeys("push"), []);
  });
  withPlatform("linux", () => {
    assert.equal(
      new HotkeyManager()._registerSingleHotkey("MouseButton5", () => {}).success,
      false
    );
  });
});
