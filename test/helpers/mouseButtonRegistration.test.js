const test = require("node:test");
const assert = require("node:assert/strict");

// Stub electron's globalShortcut before hotkeyManager loads so registration can
// run outside Electron. Mouse-button hotkeys must never claim an accelerator.
const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (accelerator.includes("BAD") || registered.has(accelerator)) return false;
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
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};

const withPlatform = async (platform, run) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

test("a mouse button hotkey registers through the Windows listener, never globalShortcut", async () => {
  await withPlatform("win32", async () => {
    const mgr = new HotkeyManager();

    const result = await mgr.registerSlot("meeting", "MouseButton4", noop, { atomic: true });

    assert.equal(result.success, true);
    assert.deepEqual(mgr.getSlotHotkeys("meeting"), ["MouseButton4"]);
    assert.deepEqual(mgr.slots.get("meeting").accelerators, [null]);
    assert.equal(registered.size, 0, "mouse buttons must not claim a globalShortcut");
  });
});

test("a mouse button primary bypasses the KDE binding and uses the low-level listener", async () => {
  await withPlatform("linux", async () => {
    const mgr = new HotkeyManager();
    mgr.useKDE = true;
    // A previous KDE binding exists for the slot.
    mgr.slots.set("voiceAgent", { hotkeys: ["F7"], callback: noop, accelerators: [] });
    const kdeCalls = [];
    mgr.kdeManager = {
      registerKeybinding: async (...args) => {
        kdeCalls.push(["register", ...args]);
        return true;
      },
      unregisterKeybinding: async (slot) => {
        kdeCalls.push(["unregister", slot]);
      },
    };

    const result = await mgr.registerSlot("voiceAgent", "MouseButton5", noop);

    assert.equal(result.success, true);
    assert.deepEqual(kdeCalls, [["unregister", "voiceAgent"]]);
    assert.deepEqual(mgr.getSlotHotkeys("voiceAgent"), ["MouseButton5"]);
    assert.deepEqual(mgr.slots.get("voiceAgent").accelerators, [null]);
    assert.equal(registered.size, 0);
  });
});

test("a mouse button primary bypasses the GNOME binding and uses the low-level listener", async () => {
  await withPlatform("linux", async () => {
    const mgr = new HotkeyManager();
    mgr.useGnome = true;
    // A previous GNOME binding exists for the slot.
    mgr.slots.set("voiceAgent", { hotkeys: ["F7"], callback: noop, accelerators: [] });
    const gnomeCalls = [];
    mgr.gnomeManager = {
      unregisterKeybinding: async (slot) => {
        gnomeCalls.push(slot);
      },
    };

    const result = await mgr.registerSlot("voiceAgent", "MouseButton4", noop);

    assert.equal(result.success, true);
    assert.deepEqual(gnomeCalls, ["voiceAgent"]);
    assert.deepEqual(mgr.getSlotHotkeys("voiceAgent"), ["MouseButton4"]);
    assert.equal(registered.size, 0);
  });
});

test("keyboard hotkeys still route through KDE — the mouse bypass must not swallow them", async () => {
  await withPlatform("linux", async () => {
    const mgr = new HotkeyManager();
    mgr.useKDE = true;
    const kdeCalls = [];
    mgr.kdeManager = {
      registerKeybinding: async (...args) => {
        kdeCalls.push(["register", ...args]);
        return true;
      },
      unregisterKeybinding: async () => {},
    };

    const result = await mgr.registerSlot("meeting", "F7", noop);

    assert.equal(result.success, true);
    assert.equal(kdeCalls.length, 1);
    assert.equal(kdeCalls[0][1], "F7");
    assert.equal(registered.size, 0, "KDE-registered slots never claim an accelerator");
  });
});

test("updateHotkey hands a mouse button from GNOME to the low-level listener", async () => {
  await withPlatform("linux", async () => {
    const mgr = new HotkeyManager();
    mgr.useGnome = true;
    const gnomeCalls = [];
    mgr.gnomeManager = {
      unregisterKeybinding: async (slot) => {
        gnomeCalls.push(slot);
      },
    };
    mgr.mainWindow = { isDestroyed: () => false, webContents: { send: () => true } };

    const result = await mgr.updateHotkey("MouseButton4", noop);

    assert.equal(result.success, true);
    assert.deepEqual(gnomeCalls, ["dictation"]);
    assert.equal(mgr.currentHotkey, "MouseButton4");
    assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["MouseButton4"]);
    assert.equal(registered.size, 0);
  });
});
