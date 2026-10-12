const test = require("node:test");
const assert = require("node:assert/strict");

// GNOME's registration answers true, false, or why GNOME can't grab the key
// (gnomeShortcut.js resolveFunctionKey). A reason is not a success, and the
// user is told the reason instead of a generic failure.
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: { unregisterAll() {} },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
test.before(() => Object.defineProperty(process, "platform", { value: "linux", configurable: true }));
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

function gnomeManager(reason) {
  const mgr = new HotkeyManager();
  const failures = [];
  mgr.useGnome = true;
  mgr.gnomeManager = {
    registeredSlots: new Set(),
    supportsPushToTalk: () => true,
    registerKeybinding: async () => reason,
    registerPushToTalk: async () => reason,
    unregisterKeybinding: async () => true,
    unregisterPushToTalk: async () => {},
    setMeetingCallback() {},
    setVoiceAgentCallback() {},
    setTranslationCallback() {},
  };
  mgr.notifyHotkeyFailure = (hotkey, result) => failures.push({ hotkey, ...result });
  return { mgr, failures };
}

test("a dictation hotkey GNOME can't grab is refused with the keymap reason", async () => {
  const { mgr } = gnomeManager("keysym_missing");
  mgr.currentHotkey = "F8";

  const result = await mgr.updateHotkey("F19", noop);

  assert.equal(result.success, false);
  assert.match(result.message, /keyboard layout/);
  assert.match(result.message, /"F19"/);
  assert.equal(mgr.currentHotkey, "F8");
});

test("another slot's hotkey GNOME already uses is refused as reserved", async () => {
  const { mgr } = gnomeManager("keysym_reserved");

  const result = await mgr.registerSlot("meeting", "F13", noop);

  assert.equal(result.success, false);
  assert.match(result.error, /reserved by your desktop environment/);
  assert.deepEqual(mgr.getSlotHotkeys("meeting"), []);
});

test("switching to Hold on a key GNOME can't grab keeps Tap and says why", async () => {
  const { mgr, failures } = gnomeManager("keysym_reserved");
  mgr.activationMode = "tap";
  mgr.currentHotkey = "F13";
  mgr.hotkeyCallback = noop;

  assert.equal(await mgr.setActivationMode("push"), false);
  assert.equal(mgr.activationMode, "tap");
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /reserved by your desktop environment/);
});
