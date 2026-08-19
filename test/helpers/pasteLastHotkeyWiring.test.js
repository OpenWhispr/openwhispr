const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron's globalShortcut before hotkeyManager loads so the pasteLast
// slot can register outside Electron, mirroring the other slot wiring tests.
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

test.beforeEach(() => registered.clear());

test("pasteLast slot registers and fires its callback on the accelerator", async () => {
  const manager = new HotkeyManager();
  let fired = 0;

  const result = await manager.registerSlot("pasteLast", "F9", () => fired++, { atomic: true });

  assert.equal(result.success, true);
  assert.deepEqual(manager.getSlotHotkeys("pasteLast"), ["F9"]);
  registered.get("F9")();
  assert.equal(fired, 1);
});

test("slotHasHotkey resolves pasteLast for the native listener dispatchers", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("pasteLast", "F9", () => {}, { atomic: true });

  assert.equal(manager.slotHasHotkey("pasteLast", "F9"), true);
  assert.equal(manager.slotHasHotkey("pasteLast", "F8"), false);
  assert.equal(manager.slotHasHotkey("dictation", "F9"), false);
});

test("clearing the pasteLast slot releases its accelerator for reuse", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("pasteLast", "F9", () => {}, { atomic: true });
  manager.unregisterSlot("pasteLast");

  assert.deepEqual(manager.getSlotHotkeys("pasteLast"), []);
  assert.equal(registered.has("F9"), false);

  const reused = await manager.registerSlot("dictation", "F9", () => {}, { atomic: true });
  assert.equal(reused.success, true);
});

test("pasteLast atomic re-register failure keeps the previous hotkey", async () => {
  const manager = new HotkeyManager();

  await manager.registerSlot("pasteLast", "F9", () => {}, { atomic: true });
  // Occupy the target accelerator so the update attempt fails.
  await manager.registerSlot("agent", "F7", () => {}, { atomic: true });

  const conflicted = await manager.registerSlot("pasteLast", "F7", () => {}, { atomic: true });

  assert.equal(conflicted.success, false);
  assert.deepEqual(manager.getSlotHotkeys("pasteLast"), ["F9"]);
});
