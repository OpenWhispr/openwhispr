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
const { bindingIdFor, slotOfBindingId } = HotkeyManager;

// Linux desktop backends used to bind hotkeys[0] and log that they ignored the
// rest, so a second dictation shortcut was silently dead on GNOME, KDE and
// Hyprland. Each row now gets its own binding, and identity comes from a
// per-binding closure because none of those backends reports which key fired.

test("index 0 keeps the bare slot name so existing OS entries stay put", () => {
  assert.equal(bindingIdFor("dictation", 0), "dictation");
  assert.equal(bindingIdFor("dictation", 1), "dictation#1");
  assert.equal(bindingIdFor("dictation", 7), "dictation#7");
  assert.equal(slotOfBindingId("dictation"), "dictation");
  assert.equal(slotOfBindingId("dictation#3"), "dictation");
  assert.equal(slotOfBindingId(undefined), "");
});

function hyprlandManager(t, { failOn = null } = {}) {
  const calls = { registered: [], unregistered: [] };
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId, callback) {
      if (failOn && hotkey === failOn) return false;
      calls.registered.push({ hotkey, bindingId, callback });
      return true;
    },
    async unregisterKeybinding(bindingId) {
      calls.unregistered.push(bindingId);
    },
  };
  return { manager, calls };
}

const hyprlandTest = process.platform === "linux" ? test : test.skip;

hyprlandTest("every row gets its own binding, not just the primary", async (t) => {
  registered.clear();
  const { manager, calls } = hyprlandManager(t);

  const result = await manager.registerSlot(
    "dictation",
    "Control+Shift+Space,Control+Alt+Shift,F9",
    () => {}
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    calls.registered.map(({ hotkey, bindingId }) => [bindingId, hotkey]),
    [
      ["dictation", "Control+Shift+Space"],
      ["dictation#1", "Control+Alt+Shift"],
      ["dictation#2", "F9"],
    ]
  );
  assert.deepEqual(manager.getSlotHotkeys("dictation"), [
    "Control+Shift+Space",
    "Control+Alt+Shift",
    "F9",
  ]);
  assert.equal(registered.size, 0, "desktop bindings never go through globalShortcut");
});

hyprlandTest("each binding reports its own identity, which the backend omits", async (t) => {
  registered.clear();
  const fired = [];
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot(
    "dictation",
    "Control+Shift+Space,Control+Alt+Shift",
    (hotkey, phase) => fired.push([hotkey, phase])
  );

  // Hyprland, KDE and the GNOME portal all call back with no hotkey.
  calls.registered[1].callback(undefined, "down");
  calls.registered[0].callback(undefined, "up");

  assert.deepEqual(fired, [
    ["Control+Alt+Shift", "down"],
    ["Control+Shift+Space", "up"],
  ]);
});

hyprlandTest("a shortened list releases the bindings it no longer owns", async (t) => {
  registered.clear();
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8,F9,F10", () => {});
  calls.unregistered.length = 0;

  await manager.registerSlot("dictation", "F8", () => {});

  assert.deepEqual(calls.unregistered, ["dictation", "dictation#1", "dictation#2"]);
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["F8"]);
  assert.deepEqual(manager.slots.get("dictation").bindingIds, ["dictation"]);
});

// A partial failure must not leave half a list bound: the previous rows come
// back, and they come back WORKING.
hyprlandTest("a partial failure unwinds and restores the previous rows", async (t) => {
  registered.clear();
  const { manager, calls } = hyprlandManager(t);
  const original = (hotkey, phase) => fired.push([hotkey, phase]);
  const fired = [];
  await manager.registerSlot("dictation", "F8,F9", original);
  calls.registered.length = 0;
  calls.unregistered.length = 0;

  manager.hyprlandManager.registerSlotKeybinding = async (hotkey, bindingId, callback) => {
    if (hotkey === "F12") return false;
    calls.registered.push({ hotkey, bindingId, callback });
    return true;
  };

  const result = await manager.registerSlot("dictation", "F11,F12", () => {});

  assert.equal(result.success, false);
  assert.equal(result.degraded, false, "the previous rows came back cleanly");
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["F8", "F9"]);
  assert.deepEqual(
    calls.registered.map(({ hotkey, bindingId }) => [bindingId, hotkey]).slice(-2),
    [
      ["dictation", "F8"],
      ["dictation#1", "F9"],
    ],
    "the restore re-registers the previous rows"
  );
});

// Restoring the literal old closures would hand back bindings stamped with a
// superseded generation, which decline every event — a silently dead hotkey.
hyprlandTest("bindings restored after a failure still dispatch", async (t) => {
  registered.clear();
  const fired = [];
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8", (hotkey, phase) => fired.push([hotkey, phase]));
  calls.registered.length = 0;

  manager.hyprlandManager.registerSlotKeybinding = async (hotkey, bindingId, callback) => {
    if (hotkey === "F12") return false;
    calls.registered.push({ hotkey, bindingId, callback });
    return true;
  };
  const result = await manager.registerSlot("dictation", "F12", () => {});
  assert.equal(result.success, false);

  const restored = calls.registered.at(-1);
  assert.equal(restored.hotkey, "F8");
  restored.callback(undefined, "down");
  assert.deepEqual(fired, [["F8", "down"]], "the restored binding must still fire");
});

// An event already in flight when the rows changed must not be delivered to
// whichever row now occupies that position.
hyprlandTest("a superseded binding declines instead of hitting the replacement row", async (t) => {
  registered.clear();
  const fired = [];
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8", (hotkey, phase) =>
    fired.push(["old", hotkey, phase])
  );
  const staleCallback = calls.registered[0].callback;

  await manager.registerSlot("dictation", "F9", (hotkey, phase) =>
    fired.push(["new", hotkey, phase])
  );

  staleCallback(undefined, "down");
  assert.deepEqual(fired, [], "a stale binding must be ignored entirely");

  calls.registered.at(-1).callback(undefined, "down");
  assert.deepEqual(fired, [["new", "F9", "down"]]);
});

hyprlandTest("every row is conflict-checked against the other slots", async (t) => {
  registered.clear();
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("meeting", "F7", () => {});
  calls.registered.length = 0;

  // The clash is on the SECOND row, which the old primary-only path never saw.
  const result = await manager.registerSlot("dictation", "F8,F7", () => {});

  assert.equal(result.success, false);
  assert.equal(result.reason, "slot_conflict");
  assert.equal(result.conflictSlot, "meeting");
  assert.deepEqual(calls.registered, [], "nothing is registered when a row conflicts");
  assert.deepEqual(manager.getSlotHotkeys("meeting"), ["F7"], "the other slot is untouched");
});

hyprlandTest("a conflicting alias of another slot's key is refused too", async (t) => {
  registered.clear();
  const { manager } = hyprlandManager(t);
  await manager.registerSlot("meeting", "Ctrl+Shift+F8", () => {});

  const result = await manager.registerSlot("dictation", "F9,Shift+Control+F8", () => {});

  assert.equal(result.success, false);
  assert.equal(result.reason, "slot_conflict");
});

// If the restore itself fails there is no clean rollback to report. Saying so
// is the point: the user is left with fewer live bindings than the UI shows.
hyprlandTest("an unrestorable previous binding is reported as degraded", async (t) => {
  registered.clear();
  const { manager } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8", () => {});

  // Nothing registers from here on: the new rows fail AND the restore fails.
  manager.hyprlandManager.registerSlotKeybinding = async () => false;
  const result = await manager.registerSlot("dictation", "F12", () => {});

  assert.equal(result.success, false);
  assert.equal(result.degraded, true, "a failed restore must not read as a clean rollback");
});

// An unregister the OS refuses leaves that key still claimed by us. Reporting
// a clean rollback then is a lie the user pays for: their old shortcut is gone
// from the UI but still captured.
hyprlandTest("a refused cleanup is reported as degraded, not as a clean rollback", async () => {
  registered.clear();
  const active = new Set();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId) {
      if (hotkey === "F12") return false;
      active.add(bindingId);
      return true;
    },
    async unregisterKeybinding(bindingId) {
      // The compositor refuses to let the secondary row go.
      if (bindingId === "dictation#1") return false;
      active.delete(bindingId);
      return true;
    },
  };

  await manager.registerSlot("dictation", "F8,F9", () => {});
  const result = await manager.registerSlot("dictation", "F10,F12", () => {});

  assert.equal(result.success, false);
  assert.equal(result.degraded, true, "an unreleased binding is not a clean rollback");
});

hyprlandTest("a cleanup that throws is also reported honestly", async () => {
  registered.clear();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey) {
      return hotkey !== "F12";
    },
    async unregisterKeybinding() {
      throw new Error("compositor is gone");
    },
  };

  await manager.registerSlot("dictation", "F8", () => {});
  const result = await manager.registerSlot("dictation", "F12", () => {});

  assert.equal(result.success, false);
  assert.equal(result.degraded, true);
});

// Clearing a slot used to release only the slot name, leaving every secondary
// row still bound at the OS while the app showed the slot as empty.
hyprlandTest("unregisterSlot releases every row, not just the first", async () => {
  registered.clear();
  const active = new Set();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId) {
      active.add(bindingId);
      return true;
    },
    async unregisterKeybinding(bindingId) {
      active.delete(bindingId);
      return true;
    },
  };

  await manager.registerSlot("dictation", "F8,F9,F10", () => {});
  assert.deepEqual([...active], ["dictation", "dictation#1", "dictation#2"]);

  assert.equal(await manager.unregisterSlot("dictation"), true);

  assert.deepEqual([...active], [], "no row may stay bound after the slot is cleared");
  assert.deepEqual(manager.getSlotHotkeys("dictation"), []);
  assert.deepEqual(manager.slots.get("dictation").bindingIds, []);
});

hyprlandTest("unregisterSlot reports false when the OS keeps a row", async () => {
  registered.clear();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding() {
      return true;
    },
    async unregisterKeybinding(bindingId) {
      return bindingId !== "dictation#1";
    },
  };

  await manager.registerSlot("dictation", "F8,F9", () => {});
  assert.equal(await manager.unregisterSlot("dictation"), false);
});

// A generation change means a new START is stale. It must NOT mean an
// in-flight hold loses its release: that leaves the mic open until the
// safety ceiling.
hyprlandTest("an owning release still arrives after the rows change", async (t) => {
  registered.clear();
  const phases = [];
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8", (hotkey, phase) => phases.push([hotkey, phase]));
  const owning = calls.registered[0].callback;

  owning(undefined, "down");
  // The user edits their rows while still holding the key.
  await manager.registerSlot("dictation", "F9", () => {});
  owning(undefined, "up");

  assert.deepEqual(phases, [
    ["F8", "down"],
    ["F8", "up"],
  ]);
  assert.equal(manager.getPressOwner(), null, "the owner is cleared once it releases");
});

hyprlandTest("a stale binding still cannot start a new recording", async (t) => {
  registered.clear();
  const phases = [];
  const { manager, calls } = hyprlandManager(t);
  await manager.registerSlot("dictation", "F8", (hotkey, phase) => phases.push([hotkey, phase]));
  const stale = calls.registered[0].callback;

  await manager.registerSlot("dictation", "F9", () => {});
  stale(undefined, "down");
  // A release from a binding that never owned a press is ignored too.
  stale(undefined, "up");

  assert.deepEqual(phases, []);
});

// N1/N2/N3: the legacy updateHotkey and setActivationMode branches registered
// only row 0 and then assigned this.currentHotkey, whose setter replaces the
// whole list. Rows 1..N disappeared from the slot and the UI while staying
// bound to the desktop and still firing, until a restart brought them back.
hyprlandTest("editing keys keeps every row in the slot and on the desktop", async () => {
  registered.clear();
  const active = new Map();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId, _callback, isPtt) {
      active.set(bindingId, { hotkey, isPtt });
      return true;
    },
    async unregisterKeybinding(bindingId) {
      active.delete(bindingId);
      return true;
    },
  };
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => {};

  const result = await manager.updateHotkey("F8,F9", () => {});

  assert.equal(result.success, true);
  assert.deepEqual(
    manager.getSlotHotkeys("dictation"),
    ["F8", "F9"],
    "the slot must keep every row, not collapse to the primary"
  );
  assert.deepEqual([...active.keys()], ["dictation", "dictation#1"]);
});

hyprlandTest("switching to Hold converts every row, not just the first", async () => {
  registered.clear();
  const active = new Map();
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.activationMode = "tap";
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId, _callback, isPtt) {
      active.set(bindingId, { hotkey, isPtt: !!isPtt });
      return true;
    },
    async unregisterKeybinding(bindingId) {
      active.delete(bindingId);
      return true;
    },
  };
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => {};
  manager.hotkeyCallback = () => {};
  await manager.updateHotkey("F8,F9", manager.hotkeyCallback);
  assert.deepEqual(
    [...active.values()].map((entry) => entry.isPtt),
    [false, false]
  );

  assert.equal(await manager.setActivationMode("push"), true);

  // Row 2 left on Tap while the control says Hold is the line-51 failure.
  assert.deepEqual(
    [...active.entries()].map(([bindingId, entry]) => [bindingId, entry.isPtt]),
    [
      ["dictation", true],
      ["dictation#1", true],
    ]
  );
});

hyprlandTest("a refused mode change puts every row back on the old mode", async () => {
  registered.clear();
  const active = new Map();
  let refuse = false;
  const manager = new HotkeyManager();
  manager.useHyprland = true;
  manager.activationMode = "tap";
  manager.hyprlandManager = {
    async registerSlotKeybinding(hotkey, bindingId, _callback, isPtt) {
      if (refuse && isPtt) return false;
      active.set(bindingId, { hotkey, isPtt: !!isPtt });
      return true;
    },
    async unregisterKeybinding(bindingId) {
      active.delete(bindingId);
      return true;
    },
  };
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => {};
  manager.notifyHotkeyFailure = () => {};
  manager.hotkeyCallback = () => {};
  await manager.updateHotkey("F8,F9", manager.hotkeyCallback);

  refuse = true;
  assert.equal(await manager.setActivationMode("push"), false);

  assert.equal(manager.activationMode, "tap");
  assert.deepEqual(
    [...active.entries()].map(([bindingId, entry]) => [bindingId, entry.isPtt]),
    [
      ["dictation", false],
      ["dictation#1", false],
    ],
    "both rows are back on Tap and still bound"
  );
});
