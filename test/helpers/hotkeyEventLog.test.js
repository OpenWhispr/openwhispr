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

test("logHotkeyEvent names the source, action, key, owning slots and extra details", async (t) => {
  const events = captureDebug(t);
  const manager = new HotkeyManager();
  await manager.registerSlot("dictation", "RightOption", () => {}, { atomic: true });
  events.length = 0;

  manager.logHotkeyEvent("macos-native", "up", "RightOption", { activationMode: "push" });

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

test("a key no slot owns is logged with an empty slot list", (t) => {
  const events = captureDebug(t);
  new HotkeyManager().logHotkeyEvent("native-listener", "down", "F13");
  assert.deepEqual(events[0].meta.slots, []);
});

test("a globalShortcut press is logged before the callback runs", async (t) => {
  const events = captureDebug(t);
  const manager = new HotkeyManager();
  const order = [];
  await manager.registerSlot("meeting", "F7", () => order.push("callback"), { atomic: true });
  events.length = 0;
  const original = debugLogger.debug;
  debugLogger.debug = (...args) => {
    order.push("log");
    original(...args);
  };
  t.after(() => {
    debugLogger.debug = original;
  });

  registered.get("F7")();

  assert.deepEqual(order, ["log", "callback"]);
  assert.equal(events[0].meta.source, "global-shortcut");
  assert.equal(events[0].meta.action, "press");
  assert.deepEqual(events[0].meta.slots, ["meeting"]);
});
