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

  // "Control+Alt" is modifier-only. Only Windows diverts those to the native
  // low-level listener; everywhere else globalShortcut owns them, so the
  // teardown has to release them too.
  await manager.registerSlot("agent", "F7,Control+Alt", noop);
  const heldAfterRegister = [...registered.keys()];

  manager.unregisterSlot("agent");

  assert.deepEqual(
    [...registered.keys()],
    [],
    `slot teardown left accelerators registered (held after register: ${heldAfterRegister.join(", ")})`
  );
  assert.deepEqual(manager.getSlotHotkeys("agent"), []);
});

test("a combo freed by unregisterSlot can be registered again", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("agent", "Control+Alt", noop, { atomic: true });
  manager.unregisterSlot("agent");

  const reregistered = await manager.registerSlot("agent", "Control+Alt", noop, { atomic: true });
  assert.equal(reregistered.success, true);
  assert.deepEqual(manager.getSlotHotkeys("agent"), ["Control+Alt"]);
});

test("unregisterSlot never releases an accelerator the slot does not own", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("agent", "F7", noop, { atomic: true });
  await manager.registerSlot("cancel", "F8", noop, { atomic: true });
  // On Linux, registration defensively unregisters its own accelerator before
  // registering it; only the teardown's unregister calls are under test here.
  unregisterCalls.length = 0;

  manager.unregisterSlot("agent");

  assert.deepEqual(unregisterCalls, ["F7"]);
  assert.deepEqual([...registered.keys()], ["F8"]);
  assert.deepEqual(manager.getSlotHotkeys("cancel"), ["F8"]);
});

test("unregisterSlot on an already-cleared slot is a no-op", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("agent", "F7", noop, { atomic: true });
  manager.unregisterSlot("agent");
  unregisterCalls.length = 0;

  manager.unregisterSlot("agent");

  assert.deepEqual(unregisterCalls, []);
});
