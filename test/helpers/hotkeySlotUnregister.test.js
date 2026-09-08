const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron's globalShortcut before hotkeyManager loads so slot
// registration can run outside Electron. `unregisterCalls` records every
// accelerator teardown attempts, including ones that were never registered.
const registered = new Map();
const unregisterCalls = [];
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        unregisterCalls.push(accelerator);
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};

test.beforeEach(() => {
  registered.clear();
  unregisterCalls.length = 0;
});

test("unregisterSlot releases every accelerator the slot registered", async () => {
  const manager = new HotkeyManager();

  // Only Windows diverts modifier-only combos to the native listener, so
  // everywhere else globalShortcut owns "Control+Alt" and must release it.
  await manager.registerSlot("meeting", "F7,Control+Alt", noop, { atomic: true });

  manager.unregisterSlot("meeting");

  assert.deepEqual([...registered.keys()], []);
  assert.deepEqual(manager.getSlotHotkeys("meeting"), []);
});

test("a combo freed by unregisterSlot can be registered again", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("meeting", "Control+Alt", noop, { atomic: true });
  manager.unregisterSlot("meeting");

  const reregistered = await manager.registerSlot("meeting", "Control+Alt", noop, { atomic: true });
  assert.equal(reregistered.success, true);
  assert.deepEqual(manager.getSlotHotkeys("meeting"), ["Control+Alt"]);
});

test("unregisterSlot never releases an accelerator the slot does not own", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("meeting", "F7", noop, { atomic: true });
  await manager.registerSlot("cancel", "F8", noop, { atomic: true });
  // Linux registration defensively unregisters first; only teardown is under test.
  unregisterCalls.length = 0;

  manager.unregisterSlot("meeting");

  assert.deepEqual(unregisterCalls, ["F7"]);
  assert.deepEqual([...registered.keys()], ["F8"]);
  assert.deepEqual(manager.getSlotHotkeys("cancel"), ["F8"]);
});

test("unregisterSlot skips hotkeys a native listener owns", async () => {
  const manager = new HotkeyManager();

  // "RightShift" gets a null accelerator on every platform.
  await manager.registerSlot("dictation", "F7,RightShift", noop, { atomic: true });
  unregisterCalls.length = 0;

  manager.unregisterSlot("dictation");

  assert.deepEqual(unregisterCalls, ["F7"]);
});

test("unregisterSlot on an already-cleared slot is a no-op", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("meeting", "F7", noop, { atomic: true });
  manager.unregisterSlot("meeting");
  unregisterCalls.length = 0;

  manager.unregisterSlot("meeting");

  assert.deepEqual(unregisterCalls, []);
});
