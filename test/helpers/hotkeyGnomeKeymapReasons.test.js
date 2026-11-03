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
test.before(() =>
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
);
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

test("a dictation hotkey GNOME can't grab is refused with the keymap reason, in Tap and Hold", async () => {
  for (const mode of ["tap", "push"]) {
    const { mgr } = gnomeManager("keysym_missing");
    mgr.activationMode = mode;
    mgr.currentHotkey = "F8";

    const result = await mgr.updateHotkey("F19", noop);

    assert.equal(result.success, false, mode);
    assert.match(result.message, /keyboard layout/);
    assert.match(result.message, /"F19"/);
    assert.equal(mgr.currentHotkey, "F8");
  }
});

test("another slot's hotkey GNOME already uses is refused as reserved and keeps the slot's key", async () => {
  const { mgr } = gnomeManager("keysym_reserved");
  const unregistered = [];
  mgr.gnomeManager.registerKeybinding = async (shortcut) =>
    shortcut === "F9" ? true : "keysym_reserved";
  mgr.gnomeManager.unregisterKeybinding = async (slot) => {
    unregistered.push(slot);
    return true;
  };
  await mgr.registerSlot("meeting", "F9", noop);

  const result = await mgr.registerSlot("meeting", "F13", noop, { atomic: true });

  assert.equal(result.success, false);
  assert.match(result.error, /GNOME already uses/);
  assert.deepEqual(mgr.getSlotHotkeys("meeting"), ["F9"]);
  assert.deepEqual(unregistered, []);
});

test("switching to Hold on a key GNOME can't grab keeps Tap and says why", async () => {
  const { mgr, failures } = gnomeManager("keysym_reserved");
  mgr.activationMode = "tap";
  mgr.currentHotkey = "F13";
  mgr.hotkeyCallback = noop;

  assert.equal(await mgr.setActivationMode("push"), false);
  assert.equal(mgr.activationMode, "tap");
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /GNOME already uses/);
});

test("switching back to Tap on a key GNOME can't grab keeps Hold and says why", async () => {
  const { mgr, failures } = gnomeManager("keysym_missing");
  const holds = [];
  mgr.gnomeManager.registerPushToTalk = async (hotkey) => {
    holds.push(hotkey);
    return true;
  };
  mgr.activationMode = "push";
  mgr.currentHotkey = "F19";
  mgr.hotkeyCallback = noop;

  assert.equal(await mgr.setActivationMode("tap"), false);
  assert.equal(mgr.activationMode, "push");
  assert.deepEqual(holds, ["F19"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /keyboard layout/);
});
