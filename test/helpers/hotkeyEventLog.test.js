const test = require("node:test");
const assert = require("node:assert/strict");

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered: (accelerator) => registered.has(accelerator),
      unregisterAll: () => registered.clear(),
    },
    BrowserWindow: class {},
  },
};

const debugLogger = require("../../src/helpers/debugLogger");
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

function captureDebug(t) {
  const events = [];
  const original = debugLogger.debug;
  debugLogger.debug = (message, meta, scope) => events.push({ message, meta, scope });
  t.after(() => {
    debugLogger.debug = original;
    registered.clear();
  });
  return events;
}

function withPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

async function managerWith(slotName, hotkey, callback = () => {}) {
  const manager = new HotkeyManager();
  await manager.registerSlot(slotName, hotkey, callback, { atomic: true });
  return manager;
}

test("logHotkeyEvent names the source, action, key, owning slots and activation mode", async (t) => {
  const events = captureDebug(t);
  const manager = await managerWith("dictation", "RightOption");
  manager.activationMode = "push";
  events.length = 0;

  manager.logHotkeyEvent("macos-native", "up", "RightOption");

  assert.deepEqual(events, [
    {
      message: "Hotkey event",
      meta: {
        source: "macos-native",
        action: "up",
        key: "RightOption",
        slots: ["dictation"],
        activationMode: "push",
      },
      scope: "hotkey",
    },
  ]);
});

test("a slot other than dictation always reads as tap", async (t) => {
  const events = captureDebug(t);
  const manager = await managerWith("voiceAgent", "RightCommand");
  manager.activationMode = "push";
  events.length = 0;

  manager.logHotkeyEvent("macos-native", "down", "RightCommand");

  assert.equal(events[0].meta.activationMode, "tap");
});

test("a key no slot owns is not logged", (t) => {
  const events = captureDebug(t);
  new HotkeyManager().logHotkeyEvent("macos-native", "down", "RightShift");
  assert.deepEqual(events, []);
});

test("nothing is logged while a new hotkey is being captured", async (t) => {
  const events = captureDebug(t);
  const manager = await managerWith("dictation", "RightOption");
  manager.setListeningMode(true);
  events.length = 0;

  manager.logHotkeyEvent("macos-native", "down", "RightOption");

  assert.deepEqual(events, []);
});

test("a desktop shortcut backend's slot event is logged under the slot's primary hotkey", async (t) => {
  const events = captureDebug(t);
  const manager = await managerWith("meeting", "F7");
  events.length = 0;

  manager.logSlotHotkeyEvent("gnome", "press", "meeting");

  assert.equal(events[0].meta.source, "gnome");
  assert.equal(events[0].meta.key, "F7");
  assert.deepEqual(events[0].meta.slots, ["meeting"]);
});

test("a globalShortcut press is logged before the callback runs", async (t) => {
  const events = captureDebug(t);
  const order = [];
  await managerWith("meeting", "F7", () => order.push("callback"));
  events.length = 0;
  const capture = debugLogger.debug;
  debugLogger.debug = (...args) => {
    order.push("log");
    capture(...args);
  };

  registered.get("F7")();

  assert.deepEqual(order, ["log", "callback"]);
  assert.equal(events[0].meta.source, "global-shortcut");
  assert.equal(events[0].meta.action, "press");
  assert.deepEqual(events[0].meta.slots, ["meeting"]);
});

test("a held globalShortcut is logged once, however often it repeats", async (t) => {
  const events = captureDebug(t);
  let calls = 0;
  await managerWith("meeting", "F7", () => calls++);
  events.length = 0;

  registered.get("F7")();
  registered.get("F7")();
  registered.get("F7")();

  assert.equal(calls, 3);
  assert.equal(events.length, 1);
});

test("a hold key the Windows listener watches is logged by the listener, not globalShortcut", async (t) => {
  withPlatform(t, "win32");
  const events = captureDebug(t);
  const manager = await managerWith("dictation", "F8");
  manager.activationMode = "push";
  events.length = 0;

  registered.get("F8")();

  assert.deepEqual(events, []);
});

test("a hotkey restored after a failed change still logs its presses", (t) => {
  const events = captureDebug(t);
  const manager = new HotkeyManager();
  manager.slots.get("dictation").hotkeys = ["F9"];

  manager._restorePreviousHotkeys(["F9"], ["F9"], () => {});
  registered.get("F9")();

  assert.equal(events.at(-1).meta.key, "F9");
  assert.equal(events.at(-1).meta.source, "global-shortcut");
});
