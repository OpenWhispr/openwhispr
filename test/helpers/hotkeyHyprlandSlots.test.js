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
const hyprlandTest = process.platform === "linux" ? test : test.skip;

async function withHyprland(fn) {
  const saved = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE,
  };
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    registered.clear();
  }
}

hyprlandTest("Hyprland optional slots do not fall back when registration fails", async () => {
  await withHyprland(async () => {
    const calls = [];
    const manager = new HotkeyManager();
    manager.useHyprland = true;
    manager.hyprlandManager = {
      async registerSlotKeybinding(hotkey) {
        calls.push(hotkey);
        return false;
      },
    };

    const result = await manager.registerSlot("meeting", "F7", () => {});
    assert.equal(result.success, false);
    assert.deepEqual(calls, ["F7"]);
    assert.deepEqual(manager.getSlotHotkeys("meeting"), []);
    assert.equal(registered.size, 0);
  });
});

hyprlandTest("Hyprland slots reject equivalent modifier aliases and ordering", async () => {
  await withHyprland(async () => {
    const calls = [];
    let releaseRemoval;
    const manager = new HotkeyManager();
    manager.useHyprland = true;
    manager.hyprlandManager = {
      async registerSlotKeybinding(...args) {
        calls.push(args);
        return true;
      },
      unregisterKeybinding() {
        return new Promise((resolve) => {
          releaseRemoval = resolve;
        });
      },
    };

    const callback = () => {};
    const registeredSlot = await manager.registerSlot("meeting", "Ctrl+Shift+F8", callback);
    assert.equal(registeredSlot.success, true);
    assert.deepEqual(manager.getSlotHotkeys("meeting"), ["Ctrl+Shift+F8"]);

    const conflict = await manager.registerSlot("translation", "Shift+Control+F8", () => {});
    assert.equal(conflict.success, false);
    assert.equal(conflict.reason, "slot_conflict");
    assert.deepEqual(calls, [["Ctrl+Shift+F8", "meeting", callback]]);

    const removal = manager.unregisterSlot("meeting");
    assert.deepEqual(manager.getSlotHotkeys("meeting"), ["Ctrl+Shift+F8"]);
    releaseRemoval(true);
    assert.equal(await removal, true);
    assert.deepEqual(manager.getSlotHotkeys("meeting"), []);
  });
});

hyprlandTest("Hyprland slots reject reversed modifier-only chords", async () => {
  await withHyprland(async () => {
    const calls = [];
    const manager = new HotkeyManager();
    manager.useHyprland = true;
    manager.hyprlandManager = {
      async registerSlotKeybinding(hotkey) {
        calls.push(hotkey);
        return true;
      },
    };

    assert.equal((await manager.registerSlot("meeting", "Alt+Super", () => {})).success, true);
    const conflict = await manager.registerSlot("translation", "Super+Alt", () => {});

    assert.equal(conflict.success, false);
    assert.equal(conflict.reason, "slot_conflict");
    assert.deepEqual(calls, ["Alt+Super"]);
  });
});

hyprlandTest("failed Hyprland initialization does not fall back to globalShortcut", async () => {
  await withHyprland(async () => {
    const manager = new HotkeyManager();
    manager.hyprlandInitializationAttempted = true;

    const result = await manager.registerSlot("meeting", "F7", () => {});
    assert.equal(result.success, false);
    assert.equal(registered.size, 0);
  });
});
