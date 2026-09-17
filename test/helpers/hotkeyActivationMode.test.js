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

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("native push-to-talk support is hotkey-aware", async () => {
  await withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.useKDE = true;

    assert.equal(manager.supportsPushToTalk("Control+Super"), false);
    assert.equal(manager.supportsPushToTalk("F8"), true);
  });
});

// globalShortcut never reports a release and re-fires on autorepeat, so a lone
// regular key held down would toggle dictation on and off. Only keys a native
// listener watches, or chords whose modifier release ends the hold, can be held.
test("macOS can hold only keys it can see released", async () => {
  await withPlatform("darwin", () => {
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

// A Windows build can ship without windows-key-listener.exe (#2005). Hold and
// modifier-only or right-side-modifier hotkeys would then never fire, so they're
// refused and the existing Tap and F8 fallbacks take over.
test("Windows refuses listener-only hotkeys when the key listener is missing", async () => {
  await withPlatform("win32", async () => {
    const manager = new HotkeyManager();
    const callback = () => undefined;

    manager.windowsKeyManager = { isAvailable: () => false };
    assert.equal(manager.supportsPushToTalk("F8"), false);
    assert.equal(await manager.setActivationMode("push"), false);
    assert.equal(manager.getEffectiveDefaultHotkey(), "F8");
    assert.deepEqual(manager.getSuggestions("Control+Shift+K"), []);
    assert.match(manager.setupShortcuts("Control+Super", callback).error, /Windows key listener/);
    assert.equal(manager.setupShortcuts("RightControl", callback).success, false);
    assert.equal(manager.setupShortcuts("F8", callback).success, true);

    manager.windowsKeyManager = { isAvailable: () => true };
    assert.equal(manager.supportsPushToTalk("F8"), true);
    assert.equal(manager.getEffectiveDefaultHotkey(), "Control+Super");
    assert.equal(manager.setupShortcuts("Control+Super", callback).success, true);
    assert.equal(manager.setupShortcuts("RightControl", callback).success, true);
  });
});

test("Windows startup moves a saved modifier-only hotkey to F8 without the key listener", async () => {
  await withPlatform("win32", async () => {
    const savedEnvHotkey = process.env.DICTATION_KEY;
    delete process.env.DICTATION_KEY;
    try {
      const manager = new HotkeyManager();
      const failures = [];
      manager.windowsKeyManager = { isAvailable: () => false };
      manager.notifyHotkeyFailure = (hotkey) => failures.push(hotkey);
      manager._persistHotkeyToEnvFile = async () => undefined;
      const mainWindow = { webContents: { executeJavaScript: async () => "Control+Super" } };

      await manager.loadSavedHotkeyOrDefault(mainWindow, () => undefined);

      assert.deepEqual(failures, ["Control+Super"]);
      assert.equal(manager.getCurrentHotkey(), "F8");
    } finally {
      if (savedEnvHotkey === undefined) delete process.env.DICTATION_KEY;
      else process.env.DICTATION_KEY = savedEnvHotkey;
    }
  });
});
