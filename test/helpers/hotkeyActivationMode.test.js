const test = require("node:test");
const assert = require("node:assert/strict");

require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register: () => true,
      unregister: () => undefined,
      isRegistered: () => false,
      unregisterAll: () => undefined,
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager");

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("native push-to-talk support is hotkey-aware", () => {
  withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.useKDE = true;

    assert.equal(manager.supportsPushToTalk("Control+Super"), false);
    assert.equal(manager.supportsPushToTalk("F8"), true);
  });
});

// globalShortcut never reports a release and re-fires on autorepeat, so a lone
// regular key held down would toggle dictation on and off. Only keys a native
// listener watches, or chords whose modifier release ends the hold, can be held.
test("macOS can hold only keys it can see released", () => {
  withPlatform("darwin", () => {
    const manager = new HotkeyManager();

    assert.equal(manager.supportsPushToTalk("F8"), false);
    assert.equal(manager.supportsPushToTalk("PageDown"), false);
    assert.equal(manager.supportsPushToTalk("GLOBE"), true);
    assert.equal(manager.supportsPushToTalk("RightOption"), true);
    assert.equal(manager.supportsPushToTalk("Control+R"), true);
    assert.equal(manager.supportsPushToTalk("MouseButton4"), true);
  });
});

test("a failed activation-mode registration preserves Tap and notifies the user", async () => {
  const manager = new HotkeyManager();
  const failures = [];
  manager.activationMode = "tap";
  manager.useGnome = true;
  manager.currentHotkey = "Alt+R";
  manager.hotkeyCallback = () => undefined;
  manager.gnomeManager = {
    registerPushToTalk: async () => false,
  };
  manager.notifyHotkeyFailure = (hotkey, result) => failures.push({ hotkey, result });

  assert.equal(await manager.setActivationMode("push"), false);
  assert.equal(manager.activationMode, "tap");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].hotkey, "Alt+R");
});
