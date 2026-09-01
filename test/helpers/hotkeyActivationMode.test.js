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

test("native push-to-talk support is hotkey-aware", () => {
  const manager = new HotkeyManager();
  manager.useKDE = true;

  assert.equal(manager.supportsPushToTalk("Control+Super"), false);
  assert.equal(manager.supportsPushToTalk("F8"), true);
});

test("non-dictation slots support Hold everywhere except DE-native backends", () => {
  const manager = new HotkeyManager();

  assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), true);
  assert.equal(manager.supportsPushToTalk("F7", "translation"), true);

  manager.useKDE = true;
  assert.equal(manager.supportsPushToTalk("F9", "voiceAgent"), false);
  assert.equal(manager.supportsPushToTalk("F7", "translation"), false);
  // Dictation keeps its own KDE answer: regular keys stay push-capable.
  assert.equal(manager.supportsPushToTalk("F8", "dictation"), true);
  assert.equal(typeof manager.getPushToTalkUnavailableReason("F9", "voiceAgent"), "string");
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
