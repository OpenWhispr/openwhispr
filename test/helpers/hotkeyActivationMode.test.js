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
    return run();
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

// Off a desktop-native backend, Linux Hold runs through the bundled evdev
// listener, so the same probe that refuses to register its hotkeys must also
// report Hold unavailable — otherwise Settings offers a mode that cannot work.
const denyProbe = (reason) => () => ({ available: false, reason });

test("linux Hold needs the listener's input access, not just its binary", () => {
  withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.nativeListenerProbe = denyProbe("input_access_denied");

    assert.equal(manager.supportsPushToTalk("F8"), false);
    assert.match(manager.getPushToTalkUnavailableReason("F8"), /usermod/);
  });
});

test("linux Hold reports the generic message when the listener binary is missing", () => {
  withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.nativeListenerProbe = denyProbe("binary_missing");

    assert.equal(manager.supportsPushToTalk("F8"), false);
    assert.equal(
      manager.getPushToTalkUnavailableReason("F8"),
      "Push-to-Talk native listener not available"
    );
  });
});

test("linux Hold stays available when the listener can run, or when nothing probed", () => {
  withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.nativeListenerProbe = () => ({ available: true });
    assert.equal(manager.supportsPushToTalk("F8"), true);

    assert.equal(new HotkeyManager().supportsPushToTalk("F8"), true);
  });
});

test("a desktop-native backend answers for Hold even when the probe fails", () => {
  withPlatform("linux", () => {
    const manager = new HotkeyManager();
    manager.useKDE = true;
    manager.nativeListenerProbe = denyProbe("input_access_denied");

    assert.equal(manager.supportsPushToTalk("Control+Super"), false);
    assert.equal(manager.supportsPushToTalk("F8"), true);
  });
});

test("switching to Hold without input access is refused and keeps Tap", async () => {
  const manager = new HotkeyManager();
  const failures = [];
  manager.activationMode = "tap";
  manager.currentHotkey = "F8";
  manager.nativeListenerProbe = denyProbe("input_access_denied");
  manager.notifyHotkeyFailure = (hotkey, result) => failures.push({ hotkey, result });

  // setActivationMode decides the refusal before its first await, so the patched
  // platform still applies when the probe is read.
  const changed = await withPlatform("linux", () => manager.setActivationMode("push"));

  assert.equal(changed, false);
  assert.equal(manager.activationMode, "tap");
  assert.equal(failures.length, 1);
  assert.match(failures[0].result.error, /usermod/);
});
