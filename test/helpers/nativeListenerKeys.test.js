const test = require("node:test");
const assert = require("node:assert/strict");

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

// Build a manager with an explicit set of slot hotkeys, independent of the
// platform default so the assertions are deterministic everywhere. A slot value
// may be a single hotkey string or an array (multi-hotkey, issue #936).
const makeManager = (slots) => {
  const mgr = new HotkeyManager();
  mgr.slots.clear();
  for (const [name, value] of Object.entries(slots)) {
    const hotkeys = Array.isArray(value) ? value : value ? [value] : [];
    mgr.slots.set(name, { hotkeys, callback: null, accelerators: [] });
  }
  return mgr;
};

test("tap mode watches modifier-only hotkeys for every slot", () => {
  const mgr = makeManager({
    dictation: "Control+Super",
    voiceAgent: "Control+Alt",
    agent: "Alt+Super",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("tap").sort(), [
    "Alt+Super",
    "Control+Alt",
    "Control+Super",
  ]);
});

test("regular key hotkeys are left to globalShortcut in tap mode", () => {
  const mgr = makeManager({ dictation: "F8", voiceAgent: "Control+Shift+A" });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), []);
});

test("push mode watches the dictation key even when it is a regular key", () => {
  const mgr = makeManager({ dictation: "F8", voiceAgent: "Control+Shift+A" });
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["F8"]);
});

test("push mode does not push-enable non-dictation slots", () => {
  const mgr = makeManager({ dictation: "Control+Super", agent: "F9" });
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["Control+Super"]);
});

test("right-side modifiers use the native listener; globe/empty slots do not", () => {
  const mgr = makeManager({
    dictation: "GLOBE",
    voiceAgent: "RightControl",
    agent: "",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});

test("a multi-hotkey slot watches each native hotkey but leaves regular keys to globalShortcut", () => {
  // dictation bound to both GLOBE (native, macOS) and Control+Shift+R (regular).
  const mgr = makeManager({ dictation: ["GLOBE", "Control+Shift+R", "RightControl"] });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});

test("push mode watches every dictation hotkey, including regular keys", () => {
  const mgr = makeManager({ dictation: ["F8", "Control+Shift+R"] });
  assert.deepEqual(mgr.getNativeListenerKeys("push").sort(), ["Control+Shift+R", "F8"]);
});

test("membership and lookup helpers work across multi-hotkey slots", () => {
  const mgr = makeManager({
    dictation: ["GLOBE", "Control+Shift+R"],
    agent: "Control+Alt",
  });
  assert.equal(mgr.slotHasHotkey("dictation", "Control+Shift+R"), true);
  assert.equal(mgr.slotHasHotkey("dictation", "F12"), false);
  assert.equal(mgr.findSlotByHotkey("Control+Shift+R"), "dictation");
  assert.equal(mgr.findSlotByHotkey("Control+Alt"), "agent");
  assert.equal(mgr.findSlotByHotkey("Nope"), null);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["GLOBE", "Control+Shift+R"]);
  assert.equal(mgr.getSlotHotkey("dictation"), "GLOBE");
});

test("_findSlotConflict detects a hotkey already bound to another slot's list", () => {
  const mgr = makeManager({
    dictation: ["GLOBE", "Control+Shift+R"],
    agent: "Control+Alt",
  });
  // Re-using a dictation hotkey for the agent slot should conflict.
  const conflict = mgr._findSlotConflict("agent", "Control+Shift+R");
  assert.equal(conflict?.reason, "slot_conflict");
  assert.equal(conflict?.conflictSlot, "dictation");
  // A fresh hotkey does not conflict.
  assert.equal(mgr._findSlotConflict("agent", "F7"), null);
  // Re-checking a slot against its own hotkey is not a conflict.
  assert.equal(mgr._findSlotConflict("dictation", "GLOBE"), null);
});

test("translation slot conflicts are detected and it is never push-enabled", () => {
  const mgr = makeManager({
    dictation: "F8",
    translation: "Control+Shift+T",
  });
  // Cross-slot conflict: reusing the translation hotkey on another slot.
  const conflict = mgr._findSlotConflict("agent", "Control+Shift+T");
  assert.equal(conflict?.reason, "slot_conflict");
  assert.equal(conflict?.conflictSlot, "translation");
  // Push mode only push-enables the dictation slot, never translation.
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["F8"]);
  // Modifier-only translation hotkeys go through the native listener in tap mode.
  const mgr2 = makeManager({ translation: "Control+Alt" });
  assert.deepEqual(mgr2.getNativeListenerKeys("tap"), ["Control+Alt"]);
});
