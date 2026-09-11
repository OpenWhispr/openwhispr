const test = require("node:test");
const assert = require("node:assert/strict");

require.cache[require.resolve("electron")] = {
  exports: {
    app: { isPackaged: false },
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

const TriggerManager = require("../../src/helpers/triggerManager");
test("generic mouse and keyboard triggers share slot registration", async () => {
  const manager = new TriggerManager();
  const registered = [];
  manager.registerSlot = async (...args) => {
    registered.push(args);
    return { success: true };
  };
  await manager.registerTrigger("dictation", { kind: "mouse", button: 3 }, () => {});
  await manager.registerTrigger(
    "dictation",
    { kind: "keyboard", accelerator: "Ctrl+F8" },
    () => {}
  );
  assert.equal(registered[0][1], "MouseButton3");
  assert.equal(registered[1][1], "Ctrl+F8");
  assert.equal(
    (await manager.registerTrigger("dictation", { kind: "mouse", button: 1 })).success,
    false
  );
});
test(
  "Windows watches mouse triggers in toggle as well as hold mode",
  { skip: process.platform !== "win32" },
  () => {
    const manager = new TriggerManager();
    manager.slots.set("dictation", { hotkeys: ["MouseButton3", "MouseButton5"] });
    assert.deepEqual(manager.getNativeListenerKeys("tap"), ["MouseButton3", "MouseButton5"]);
    assert.deepEqual(manager.getNativeListenerKeys("push"), ["MouseButton3", "MouseButton5"]);
  }
);
